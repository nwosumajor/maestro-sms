-- =============================================================================
-- attendance_record → RANGE-partitioned by month on a denormalised "date"
-- =============================================================================
-- The largest table in the product: 201 MB today, and roughly 2.85 M rows per
-- 1,000-pupil school over fifteen years (one row per pupil per school day). It
-- had NO retention path of any kind, while the yearly SchoolArchive already
-- captures attendance — so a school archived its register and then kept every
-- row for ever regardless.
--
-- WHY PARTITION RATHER THAN DELETE. This repo has already measured what bulk
-- deletion costs: VACUUM never shrinks a btree, and retention churn once left
-- 1,026 MB of indexes where 534 MB was needed — `attendance_record_sessionId_
-- studentId_key` itself went 409 MB -> 8.4 MB on a REINDEX. Freeing space by
-- DELETE therefore trades one problem for another. DETACH is metadata-only: it
-- releases the space at once and leaves no bloat behind.
--
-- It also keeps INSERT cost flat. Every register write touches this table's
-- indexes; per-partition indexes stay small instead of degrading with fifteen
-- years of history.
--
-- WHY A DENORMALISED DATE. Postgres can only partition on a column of the table
-- itself, and the school day lived only on `attendance_session`. `date` is
-- functionally determined by `sessionId` and never changes for a session, so a
-- row can never move between partitions. It also removes a join from every
-- windowed read, which used to filter through `session: { date: … }`.
--
-- NO DROP POLICY IS INTRODUCED HERE, deliberately and for the same reason the
-- audit_log migration gives: how long a school's register is kept is a POLICY
-- decision with legal weight, not a refactor. This makes executing that decision
-- cheap and instant when it is taken.
--
-- Order mirrors 20260824000000_audit_log_partition, including its two hard-won
-- details: RLS comes OFF before the copy (FORCE applies to the owner, and the
-- migrate role is not a superuser on RDS — the copy would silently read ZERO
-- rows), and the old table and its schema-global index names are renamed out of
-- the way first.
-- =============================================================================

-- 1. Take RLS off the old table so the copy sees every row.
ALTER TABLE "attendance_record" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "attendance_record" DISABLE ROW LEVEL SECURITY;

-- 2. Move the old table + its schema-global index names aside.
ALTER TABLE "attendance_record" RENAME TO "attendance_record_old";
ALTER INDEX "attendance_record_pkey"                    RENAME TO "attendance_record_old_pkey";
ALTER INDEX "attendance_record_sessionId_studentId_key" RENAME TO "attendance_record_old_sessionId_studentId_key";
ALTER INDEX "attendance_record_schoolId_idx"            RENAME TO "attendance_record_old_schoolId_idx";
ALTER INDEX "attendance_record_schoolId_sessionId_idx"  RENAME TO "attendance_record_old_schoolId_sessionId_idx";
ALTER INDEX "attendance_record_schoolId_studentId_idx"  RENAME TO "attendance_record_old_schoolId_studentId_idx";

-- 3. The partitioned parent. Postgres forces the partition key into every
--    PK/UNIQUE, so they become (id, date) and (sessionId, studentId, date). The
--    second does NOT weaken the one-record-per-pupil-per-register rule: the date
--    is derived from the session, so there is no other date that pair could have.
CREATE TABLE "attendance_record" (
    "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"  UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "status"    "AttendanceStatus" NOT NULL,
    "note"      TEXT,
    "date"      DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "attendance_record_pkey" PRIMARY KEY ("id", "date")
) PARTITION BY RANGE ("date");

-- 4. Partition factory. A partition is a real table, so it gets its own RLS —
--    the parent's policies cover parent-routed queries (all the app ever does),
--    but direct access must still be tenant-isolated. Golden Rule #2/#7.
--    Idempotent: returns the existing name if already present.
CREATE OR REPLACE FUNCTION ensure_attendance_record_partition(p_month DATE)
RETURNS TEXT AS $$
DECLARE
    start_d   DATE := date_trunc('month', p_month)::date;
    end_d     DATE := (date_trunc('month', p_month) + INTERVAL '1 month')::date;
    part_name TEXT := 'attendance_record_' || to_char(date_trunc('month', p_month), 'YYYY_MM');
BEGIN
    IF to_regclass('public.' || quote_ident(part_name)) IS NOT NULL THEN
        RETURN part_name;
    END IF;
    EXECUTE format(
        'CREATE TABLE %I PARTITION OF "attendance_record" FOR VALUES FROM (%L) TO (%L)',
        part_name, start_d, end_d);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part_name);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', part_name);
    EXECUTE format(
        'CREATE POLICY %I ON %I FOR SELECT USING ("schoolId" = current_setting(''app.current_school_id'', true)::uuid)',
        part_name || '_select', part_name);
    EXECUTE format(
        'CREATE POLICY %I ON %I FOR INSERT WITH CHECK ("schoolId" = current_setting(''app.current_school_id'', true)::uuid)',
        part_name || '_insert', part_name);
    EXECUTE format(
        'CREATE POLICY %I ON %I FOR UPDATE USING ("schoolId" = current_setting(''app.current_school_id'', true)::uuid) WITH CHECK ("schoolId" = current_setting(''app.current_school_id'', true)::uuid)',
        part_name || '_update', part_name);
    RETURN part_name;
END;
$$ LANGUAGE plpgsql;

-- 5. Cover every month that already has a register, plus 3 ahead. The daily
--    maintenance job rolls this window forward from here.
DO $$
DECLARE m DATE;
BEGIN
    FOR m IN
        SELECT generate_series(
            date_trunc('month', COALESCE((SELECT min(s."date") FROM "attendance_session" s), now()::date)),
            date_trunc('month', now()) + INTERVAL '3 months',
            INTERVAL '1 month')::date
    LOOP
        PERFORM ensure_attendance_record_partition(m);
    END LOOP;
END $$;

-- 6. DEFAULT partition — an INSERT can never fail for want of one. Rows here are
--    correct and tenant-isolated; keeping it empty is the job's job.
CREATE TABLE "attendance_record_default" PARTITION OF "attendance_record" DEFAULT;
ALTER TABLE "attendance_record_default" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_record_default" FORCE  ROW LEVEL SECURITY;
CREATE POLICY attendance_record_default_select ON "attendance_record_default" FOR SELECT
    USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY attendance_record_default_insert ON "attendance_record_default" FOR INSERT
    WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY attendance_record_default_update ON "attendance_record_default" FOR UPDATE
    USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
    WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

-- 7. Copy the history, taking the date from the session, then PROVE nothing was
--    lost before dropping the original.
INSERT INTO "attendance_record" ("id", "schoolId", "sessionId", "studentId", "status", "note", "date", "createdAt", "updatedAt")
SELECT r."id", r."schoolId", r."sessionId", r."studentId", r."status", r."note", s."date", r."createdAt", r."updatedAt"
FROM "attendance_record_old" r
JOIN "attendance_session" s ON s."id" = r."sessionId";

DO $$
DECLARE old_n BIGINT; new_n BIGINT;
BEGIN
    SELECT count(*) INTO old_n FROM "attendance_record_old";
    SELECT count(*) INTO new_n FROM "attendance_record";
    IF old_n <> new_n THEN
        RAISE EXCEPTION 'attendance_record partition copy mismatch: % old rows vs % copied — aborting', old_n, new_n;
    END IF;
END $$;

DROP TABLE "attendance_record_old";

-- 8. Indexes (free to take the original names now). Created on the parent, they
--    propagate to every existing and future partition.
CREATE UNIQUE INDEX "attendance_record_sessionId_studentId_date_key" ON "attendance_record"("sessionId", "studentId", "date");
CREATE INDEX "attendance_record_schoolId_idx"           ON "attendance_record"("schoolId");
CREATE INDEX "attendance_record_schoolId_sessionId_idx" ON "attendance_record"("schoolId", "sessionId");
CREATE INDEX "attendance_record_schoolId_studentId_idx" ON "attendance_record"("schoolId", "studentId");

-- 9. Foreign keys — same names and semantics as before.
ALTER TABLE "attendance_record" ADD CONSTRAINT "attendance_record_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "attendance_record" ADD CONSTRAINT "attendance_record_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "attendance_session"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "attendance_record" ADD CONSTRAINT "attendance_record_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "user"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- 10. Restore tenant isolation HERE, not by relying on the RLS file.
--     `docker-entrypoint.sh` applies each rls/*.sql keyed on that file's LAST
--     policy as a sentinel — and for 08_attendance_rls.sql that sentinel IS
--     `attendance_record_update`. Recreating the policies here keeps the
--     sentinel satisfied so the file is skipped rather than half re-applied.
--     Mirrors 08_attendance_rls.sql exactly.
ALTER TABLE "attendance_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_record" FORCE  ROW LEVEL SECURITY;
CREATE POLICY attendance_record_select ON "attendance_record" FOR SELECT
    USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY attendance_record_insert ON "attendance_record" FOR INSERT
    WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY attendance_record_update ON "attendance_record" FOR UPDATE
    USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
    WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

-- Least privilege, unchanged: a register is corrected, never deleted. Privileges
-- are checked on the PARENT for parent-routed queries, so partitions get none —
-- which also blocks direct partition access.
GRANT  SELECT, INSERT, UPDATE ON "attendance_record" TO major_user;
REVOKE DELETE, TRUNCATE       ON "attendance_record" FROM major_user;

-- =============================================================================
-- audit_log → RANGE-partitioned by month on "createdAt"   (scaling Phase 5)
-- =============================================================================
-- audit_log is the platform's highest-write table (Golden Rule #5: every mutation
-- writes one) and it grows FOREVER — at 5,000 schools it becomes the largest
-- relation by an order of magnitude. Monthly range partitioning keeps each
-- partition's indexes small (so insert cost stays flat instead of degrading with
-- total history), lets autovacuum work per-partition instead of over one enormous
-- heap, prunes date-filtered reads to a single month, and makes any future
-- archival a metadata-only DETACH/DROP rather than a bloat-generating DELETE.
--
-- NOTE: no retention/drop policy is introduced here. Audit logs are compliance
-- records (NDPR); deciding how long to keep them is a POLICY call, not a
-- refactor. This migration only makes that decision cheap to execute later.
--
-- Postgres forces the partition key into every PK/UNIQUE constraint, so the key
-- becomes (id, "createdAt"). Safe here: audit_log is append-only and the code
-- only ever calls findMany/create — never findUnique/update/delete by id.
--
-- Order below is deliberate:
--   1. RLS is DISABLED on the old table BEFORE the copy. `FORCE ROW LEVEL
--      SECURITY` applies to the table OWNER too, and the migrate role is NOT a
--      superuser on RDS — so the copy's SELECT would be silently filtered to ZERO
--      rows by a policy whose GUC is unset. That would be silent data loss. The
--      row-count assertion below is the backstop.
--   2. The old table + its indexes are RENAMED out of the way first: index names
--      are schema-global, so the new table cannot claim `audit_log_pkey` etc.
--      while the old one still holds them.
-- =============================================================================

-- 1. Take RLS off the old table so the copy sees every row (see note above).
ALTER TABLE "audit_log" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" DISABLE ROW LEVEL SECURITY;

-- 2. Move the old table + its schema-global index names aside.
ALTER TABLE "audit_log" RENAME TO "audit_log_old";
ALTER INDEX "audit_log_pkey" RENAME TO "audit_log_old_pkey";
ALTER INDEX "audit_log_schoolId_idx" RENAME TO "audit_log_old_schoolId_idx";
ALTER INDEX "audit_log_schoolId_entity_entityId_idx" RENAME TO "audit_log_old_schoolId_entity_entityId_idx";
ALTER INDEX "audit_log_schoolId_createdAt_idx" RENAME TO "audit_log_old_schoolId_createdAt_idx";

-- 3. The partitioned parent. Columns/types/defaults mirror the original exactly.
CREATE TABLE "audit_log" (
    "id"        UUID NOT NULL,
    "schoolId"  UUID NOT NULL,
    "actorId"   UUID NOT NULL,
    "action"    TEXT NOT NULL,
    "entity"    TEXT NOT NULL,
    "entityId"  TEXT NOT NULL,
    "metadata"  JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");

-- 4. Partition factory. Creating a partition ALSO gives it its own RLS: the
--    parent's policies already cover parent-routed queries (all the app ever
--    does), but a partition is a real table — if anything is ever granted direct
--    access, it must still be tenant-isolated. Defence in depth (Golden Rule #2/#7).
--    Idempotent: returns the existing partition name if already present.
CREATE OR REPLACE FUNCTION ensure_audit_log_partition(p_month DATE)
RETURNS TEXT AS $$
DECLARE
    start_ts  TIMESTAMP := date_trunc('month', p_month::timestamp);
    end_ts    TIMESTAMP := date_trunc('month', p_month::timestamp) + INTERVAL '1 month';
    part_name TEXT       := 'audit_log_' || to_char(date_trunc('month', p_month::timestamp), 'YYYY_MM');
BEGIN
    IF to_regclass('public.' || quote_ident(part_name)) IS NOT NULL THEN
        RETURN part_name;
    END IF;
    EXECUTE format(
        'CREATE TABLE %I PARTITION OF "audit_log" FOR VALUES FROM (%L) TO (%L)',
        part_name, start_ts, end_ts);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part_name);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', part_name);
    EXECUTE format(
        'CREATE POLICY %I ON %I FOR SELECT USING ("schoolId" = current_setting(''app.current_school_id'', true)::uuid)',
        part_name || '_select', part_name);
    EXECUTE format(
        'CREATE POLICY %I ON %I FOR INSERT WITH CHECK ("schoolId" = current_setting(''app.current_school_id'', true)::uuid)',
        part_name || '_insert', part_name);
    RETURN part_name;
END;
$$ LANGUAGE plpgsql;

-- 5. Cover every month that already has data, plus 3 months ahead. The scheduled
--    maintenance job keeps rolling this window forward.
DO $$
DECLARE m DATE;
BEGIN
    FOR m IN
        SELECT generate_series(
            date_trunc('month', COALESCE((SELECT min("createdAt") FROM "audit_log_old"), now())),
            date_trunc('month', now()) + INTERVAL '3 months',
            INTERVAL '1 month')::date
    LOOP
        PERFORM ensure_audit_log_partition(m);
    END LOOP;
END $$;

-- 6. DEFAULT partition — a safety net so an INSERT can NEVER fail for want of a
--    partition (e.g. if the maintenance job stalls). Rows here are still correct
--    and tenant-isolated; the job's job is to keep it empty.
CREATE TABLE "audit_log_default" PARTITION OF "audit_log" DEFAULT;
ALTER TABLE "audit_log_default" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log_default" FORCE  ROW LEVEL SECURITY;
CREATE POLICY audit_log_default_select ON "audit_log_default" FOR SELECT
    USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY audit_log_default_insert ON "audit_log_default" FOR INSERT
    WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

-- 7. Copy the history, then PROVE nothing was lost before dropping the original.
INSERT INTO "audit_log" ("id", "schoolId", "actorId", "action", "entity", "entityId", "metadata", "createdAt")
SELECT "id", "schoolId", "actorId", "action", "entity", "entityId", "metadata", "createdAt" FROM "audit_log_old";

DO $$
DECLARE old_n BIGINT; new_n BIGINT;
BEGIN
    SELECT count(*) INTO old_n FROM "audit_log_old";
    SELECT count(*) INTO new_n FROM "audit_log";
    IF old_n <> new_n THEN
        RAISE EXCEPTION 'audit_log partition copy mismatch: % old rows vs % copied — aborting', old_n, new_n;
    END IF;
END $$;

DROP TABLE "audit_log_old";

-- 8. Indexes (now free to take the original names). On a partitioned parent these
--    are created on every existing and future partition automatically.
CREATE INDEX "audit_log_schoolId_idx" ON "audit_log"("schoolId");
CREATE INDEX "audit_log_schoolId_entity_entityId_idx" ON "audit_log"("schoolId", "entity", "entityId");
CREATE INDEX "audit_log_schoolId_createdAt_idx" ON "audit_log"("schoolId", "createdAt");

-- 9. Foreign keys — same names/semantics as before (FKs FROM a partitioned table
--    are supported since PG 12).
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "user"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- 10. Restore tenant isolation on the parent — IN THIS MIGRATION, not by relying
--     on the RLS files. `docker-entrypoint.sh` applies each rls/*.sql idempotently
--     keyed on that file's LAST policy as a sentinel; audit_log's policies live in
--     02_foundation_rls.sql whose sentinel is a DIFFERENT table's policy, so the
--     file would be SKIPPED and audit_log would come back with NO RLS. Recreating
--     the policies + grants here closes that hole. Mirrors 02_foundation_rls.sql.
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE  ROW LEVEL SECURITY;
CREATE POLICY audit_log_select ON "audit_log" FOR SELECT
    USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY audit_log_insert ON "audit_log" FOR INSERT
    WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

-- Least privilege, unchanged: append-only for the app role. Privileges for
-- parent-routed queries are checked on the PARENT, so partitions need no grants —
-- and deliberately get none, which also blocks direct partition access.
GRANT  SELECT, INSERT           ON "audit_log" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM major_user;

-- =============================================================================
-- Attendance RLS + grants
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md). Run AFTER migration
-- 20260620110000_attendance, as the PRIVILEGED migration role.
--
-- Both tables are tenant-scoped read/write; same fail-closed predicate as the
-- rest. Relationship scoping (teacher-of-class / parent-of-child / self / school
-- staff) is enforced in AttendanceService ON TOP of this tenant isolation.
--
-- Records are corrected (UPDATE), never hard-deleted: no DELETE policy/grant.
-- Sentinel for the entrypoint apply guard = the LAST policy: attendance_record_update.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- attendance_session  (read/write; no delete)
-- -----------------------------------------------------------------------------
ALTER TABLE "attendance_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_session" FORCE  ROW LEVEL SECURITY;

-- Re-runnable throughout (see the attendance_record note below): this file's
-- marker in docker-entrypoint.sh cannot be its LAST policy, because the last
-- three are also created by a migration, so the file must be safe to apply
-- again whichever policy marks it.
DROP POLICY IF EXISTS attendance_session_select ON "attendance_session";
DROP POLICY IF EXISTS attendance_session_insert ON "attendance_session";
DROP POLICY IF EXISTS attendance_session_update ON "attendance_session";

CREATE POLICY attendance_session_select ON "attendance_session" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY attendance_session_insert ON "attendance_session" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY attendance_session_update ON "attendance_session" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "attendance_session" TO major_user;
REVOKE DELETE, TRUNCATE       ON "attendance_session" FROM major_user;

-- -----------------------------------------------------------------------------
-- attendance_record  (read/write; no delete)
-- -----------------------------------------------------------------------------
ALTER TABLE "attendance_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_record" FORCE  ROW LEVEL SECURITY;

-- DROP-then-CREATE, like 02_foundation_rls.sql's audit_log policies, and for
-- the same reason: migration 20270110000000_attendance_record_partition
-- re-declares these three names when it partitions the table. With a bare
-- CREATE, every install that ran that migration first (every fresh one) hit
-- "policy already exists" here; `pnpm rls` stopped this file at that line and
-- carried on, and the production entrypoint, whose marker for this file was
-- `attendance_record_update` — a policy the MIGRATION creates — skipped the
-- whole file, leaving attendance_session with RLS off, no policies and no
-- grants on a fresh production database.
DROP POLICY IF EXISTS attendance_record_select ON "attendance_record";
DROP POLICY IF EXISTS attendance_record_insert ON "attendance_record";
DROP POLICY IF EXISTS attendance_record_update ON "attendance_record";

CREATE POLICY attendance_record_select ON "attendance_record" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY attendance_record_insert ON "attendance_record" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY attendance_record_update ON "attendance_record" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "attendance_record" TO major_user;
REVOKE DELETE, TRUNCATE       ON "attendance_record" FROM major_user;

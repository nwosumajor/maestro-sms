-- =============================================================================
-- student_import_batch RLS + grants
-- =============================================================================
-- Tenant-scoped. SELECT/INSERT/UPDATE only (no DELETE) — the staged batch + its
-- maker-checker decision are retained as a trail. Same fail-closed predicate the
-- rest of the system uses. Run as the privileged migration role. Sentinel:
-- student_import_batch_update (the last policy created).
-- =============================================================================

ALTER TABLE "student_import_batch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "student_import_batch" FORCE  ROW LEVEL SECURITY;

CREATE POLICY student_import_batch_select ON "student_import_batch" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY student_import_batch_insert ON "student_import_batch" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY student_import_batch_update ON "student_import_batch" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "student_import_batch" TO major_user;
REVOKE DELETE, TRUNCATE       ON "student_import_batch" FROM major_user;

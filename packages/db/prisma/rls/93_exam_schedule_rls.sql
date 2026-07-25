-- =============================================================================
-- exam_schedule RLS + grants
-- =============================================================================
-- The approvable batch of exam sittings for a term. Tenant-scoped (school_id
-- non-null); standard fail-closed predicate. App role gets full CRUD (the
-- maker-checker on approval is enforced in the service + workflow engine). Run
-- as the privileged migration role. Sentinel: exam_schedule_delete.
-- =============================================================================

ALTER TABLE "exam_schedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exam_schedule" FORCE  ROW LEVEL SECURITY;
CREATE POLICY exam_schedule_select ON "exam_schedule" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY exam_schedule_insert ON "exam_schedule" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY exam_schedule_update ON "exam_schedule" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY exam_schedule_delete ON "exam_schedule" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "exam_schedule" TO major_user;
REVOKE TRUNCATE ON "exam_schedule" FROM major_user;

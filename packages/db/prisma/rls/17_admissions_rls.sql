-- =============================================================================
-- Admissions RLS + grants
-- =============================================================================
-- Tenant-scoped. The PUBLIC submit sets app.current_school_id from the school
-- slug resolved server-side (never client input), so the INSERT is tenant-bound.
-- Staff read/update; quarantined from student data. Sentinel = admission_application_update.
-- =============================================================================
ALTER TABLE "admission_application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admission_application" FORCE  ROW LEVEL SECURITY;
CREATE POLICY admission_application_select ON "admission_application" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY admission_application_insert ON "admission_application" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY admission_application_update ON "admission_application" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "admission_application" TO major_user;
REVOKE DELETE, TRUNCATE       ON "admission_application" FROM major_user;

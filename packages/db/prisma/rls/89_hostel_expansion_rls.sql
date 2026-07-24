-- =============================================================================
-- hostel_attendance / hostel_exeat / hostel_incident RLS + grants
-- =============================================================================
-- Roll-call, exeat/gate-pass and the maintenance/incident log. All tenant-scoped
-- (school_id non-null); standard fail-closed predicate. App role gets full CRUD;
-- relationship scoping (warden/staff vs student-self) is enforced in the service.
-- Run as the privileged migration role. Sentinel: hostel_incident_delete.
-- =============================================================================

ALTER TABLE "hostel_attendance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hostel_attendance" FORCE  ROW LEVEL SECURITY;
CREATE POLICY hostel_attendance_select ON "hostel_attendance" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_attendance_insert ON "hostel_attendance" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_attendance_update ON "hostel_attendance" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_attendance_delete ON "hostel_attendance" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "hostel_exeat" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hostel_exeat" FORCE  ROW LEVEL SECURITY;
CREATE POLICY hostel_exeat_select ON "hostel_exeat" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_exeat_insert ON "hostel_exeat" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_exeat_update ON "hostel_exeat" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_exeat_delete ON "hostel_exeat" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "hostel_incident" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hostel_incident" FORCE  ROW LEVEL SECURITY;
CREATE POLICY hostel_incident_select ON "hostel_incident" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_incident_insert ON "hostel_incident" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_incident_update ON "hostel_incident" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_incident_delete ON "hostel_incident" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "hostel_attendance" TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "hostel_exeat"      TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "hostel_incident"   TO major_user;

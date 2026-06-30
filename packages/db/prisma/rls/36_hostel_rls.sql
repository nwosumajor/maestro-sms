-- =============================================================================
-- hostel / hostel_room / hostel_allocation RLS + grants
-- =============================================================================
-- All tenant-scoped (school_id non-null). Standard fail-closed predicate
-- (current_setting('app.current_school_id', true)). The app role gets full CRUD;
-- relationship scoping (warden/staff vs student-self) is enforced in the service.
-- Run as the privileged migration role. Sentinel: hostel_allocation_delete.
-- =============================================================================

ALTER TABLE "hostel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hostel" FORCE  ROW LEVEL SECURITY;
CREATE POLICY hostel_select ON "hostel" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_insert ON "hostel" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_update ON "hostel" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_delete ON "hostel" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "hostel_room" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hostel_room" FORCE  ROW LEVEL SECURITY;
CREATE POLICY hostel_room_select ON "hostel_room" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_room_insert ON "hostel_room" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_room_update ON "hostel_room" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_room_delete ON "hostel_room" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "hostel_allocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hostel_allocation" FORCE  ROW LEVEL SECURITY;
CREATE POLICY hostel_allocation_select ON "hostel_allocation" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_allocation_insert ON "hostel_allocation" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_allocation_update ON "hostel_allocation" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY hostel_allocation_delete ON "hostel_allocation" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "hostel"            TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "hostel_room"       TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "hostel_allocation" TO major_user;

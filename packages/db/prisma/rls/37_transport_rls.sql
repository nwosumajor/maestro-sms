-- =============================================================================
-- vehicle / transport_route / route_stop / transport_assignment RLS + grants
-- =============================================================================
-- All tenant-scoped (school_id non-null). Standard fail-closed predicate. App
-- role gets full CRUD; relationship scoping is enforced in the service. Run as
-- the privileged migration role. Sentinel: transport_assignment_delete.
-- =============================================================================

ALTER TABLE "vehicle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle" FORCE  ROW LEVEL SECURITY;
CREATE POLICY vehicle_select ON "vehicle" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY vehicle_insert ON "vehicle" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY vehicle_update ON "vehicle" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY vehicle_delete ON "vehicle" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "transport_route" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transport_route" FORCE  ROW LEVEL SECURITY;
CREATE POLICY transport_route_select ON "transport_route" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY transport_route_insert ON "transport_route" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY transport_route_update ON "transport_route" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY transport_route_delete ON "transport_route" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "route_stop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "route_stop" FORCE  ROW LEVEL SECURITY;
CREATE POLICY route_stop_select ON "route_stop" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY route_stop_insert ON "route_stop" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY route_stop_update ON "route_stop" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY route_stop_delete ON "route_stop" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "transport_assignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transport_assignment" FORCE  ROW LEVEL SECURITY;
CREATE POLICY transport_assignment_select ON "transport_assignment" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY transport_assignment_insert ON "transport_assignment" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY transport_assignment_update ON "transport_assignment" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY transport_assignment_delete ON "transport_assignment" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "vehicle"              TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "transport_route"      TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "route_stop"           TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "transport_assignment" TO major_user;

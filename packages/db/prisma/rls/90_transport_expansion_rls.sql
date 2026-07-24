-- =============================================================================
-- transport_trip / transport_boarding / vehicle_maintenance / vehicle_location
-- RLS + grants
-- =============================================================================
-- AM/PM trip schedules, boarding confirmations (child-safety), the maintenance/
-- fuel log and live GPS breadcrumbs. All tenant-scoped (school_id non-null);
-- standard fail-closed predicate. App role gets full CRUD; relationship scoping
-- (driver/staff vs passenger-self) is enforced in the service. transport_boarding
-- and vehicle_location are append-only in the service (never updated/deleted).
-- Run as the privileged migration role. Sentinel: vehicle_location_delete.
-- =============================================================================

ALTER TABLE "transport_trip" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transport_trip" FORCE  ROW LEVEL SECURITY;
CREATE POLICY transport_trip_select ON "transport_trip" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY transport_trip_insert ON "transport_trip" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY transport_trip_update ON "transport_trip" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY transport_trip_delete ON "transport_trip" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "transport_boarding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transport_boarding" FORCE  ROW LEVEL SECURITY;
CREATE POLICY transport_boarding_select ON "transport_boarding" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY transport_boarding_insert ON "transport_boarding" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY transport_boarding_update ON "transport_boarding" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY transport_boarding_delete ON "transport_boarding" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "vehicle_maintenance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle_maintenance" FORCE  ROW LEVEL SECURITY;
CREATE POLICY vehicle_maintenance_select ON "vehicle_maintenance" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY vehicle_maintenance_insert ON "vehicle_maintenance" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY vehicle_maintenance_update ON "vehicle_maintenance" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY vehicle_maintenance_delete ON "vehicle_maintenance" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "vehicle_location" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle_location" FORCE  ROW LEVEL SECURITY;
CREATE POLICY vehicle_location_select ON "vehicle_location" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY vehicle_location_insert ON "vehicle_location" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY vehicle_location_update ON "vehicle_location" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY vehicle_location_delete ON "vehicle_location" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "transport_trip"       TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "transport_boarding"   TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "vehicle_maintenance"  TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "vehicle_location"     TO major_user;

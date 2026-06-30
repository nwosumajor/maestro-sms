-- =============================================================================
-- alumnus RLS + grants
-- =============================================================================
-- Tenant-scoped (school_id non-null). Standard fail-closed predicate. App role
-- gets full CRUD; staff-only access enforced in the service. Run as the
-- privileged migration role. Sentinel: alumnus_delete.
-- =============================================================================

ALTER TABLE "alumnus" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alumnus" FORCE  ROW LEVEL SECURITY;
CREATE POLICY alumnus_select ON "alumnus" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY alumnus_insert ON "alumnus" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY alumnus_update ON "alumnus" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY alumnus_delete ON "alumnus" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "alumnus" TO major_user;

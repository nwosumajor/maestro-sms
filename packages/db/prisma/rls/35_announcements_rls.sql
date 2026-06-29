-- =============================================================================
-- announcement RLS + grants
-- =============================================================================
-- Tenant-scoped. SELECT/INSERT/UPDATE/DELETE for the app role (managers can edit/
-- delete their school's notices; audience filtering is done in the service). Same
-- fail-closed predicate the rest of the system uses. Run as the privileged
-- migration role. Sentinel: announcement_delete (the last policy created).
-- =============================================================================

ALTER TABLE "announcement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "announcement" FORCE  ROW LEVEL SECURITY;

CREATE POLICY announcement_select ON "announcement" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY announcement_insert ON "announcement" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY announcement_update ON "announcement" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY announcement_delete ON "announcement" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "announcement" TO major_user;

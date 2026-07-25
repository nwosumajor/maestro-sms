-- =============================================================================
-- school_holiday RLS + grants
-- =============================================================================
-- Non-teaching days / breaks. Tenant-scoped (school_id non-null); standard
-- fail-closed predicate. App role gets full CRUD (academic.manage is enforced in
-- the service; a holiday is a school fact with no PII). Run as the privileged
-- migration role. Sentinel: school_holiday_delete.
-- =============================================================================

ALTER TABLE "school_holiday" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "school_holiday" FORCE  ROW LEVEL SECURITY;
CREATE POLICY school_holiday_select ON "school_holiday" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY school_holiday_insert ON "school_holiday" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY school_holiday_update ON "school_holiday" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY school_holiday_delete ON "school_holiday" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "school_holiday" TO major_user;
REVOKE TRUNCATE ON "school_holiday" FROM major_user;

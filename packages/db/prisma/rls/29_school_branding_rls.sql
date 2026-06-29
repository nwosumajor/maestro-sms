-- =============================================================================
-- School branding RLS + grants (per-tenant login logo)
-- =============================================================================
-- Run AFTER migration 20260628*_school_branding, as the PRIVILEGED role. Tenant-
-- scoped; the principal (school.branding.manage) maintains their own row. The
-- public login-branding endpoint reads it after resolving the school by slug and
-- setting the tenant GUC, so the same RLS predicate applies. No hard delete
-- (logoKey is nulled to "remove"). Sentinel = LAST policy: school_branding_update.
-- =============================================================================

ALTER TABLE "school_branding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "school_branding" FORCE  ROW LEVEL SECURITY;
CREATE POLICY school_branding_select ON "school_branding" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY school_branding_insert ON "school_branding" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY school_branding_update ON "school_branding" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "school_branding" TO major_user;
REVOKE DELETE, TRUNCATE       ON "school_branding" FROM major_user;

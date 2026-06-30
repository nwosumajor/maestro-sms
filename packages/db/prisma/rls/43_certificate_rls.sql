-- =============================================================================
-- issued_certificate RLS + grants
-- =============================================================================
-- Tenant-scoped (school_id non-null). Append-only log: app role gets SELECT +
-- INSERT only (no UPDATE/DELETE — issuance history is immutable). Standard fail-
-- closed predicate. Run as the privileged migration role. Sentinel:
-- issued_certificate_insert.
-- =============================================================================

ALTER TABLE "issued_certificate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issued_certificate" FORCE  ROW LEVEL SECURITY;
CREATE POLICY issued_certificate_select ON "issued_certificate" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY issued_certificate_insert ON "issued_certificate" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT ON "issued_certificate" TO major_user;

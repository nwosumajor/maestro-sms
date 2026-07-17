-- =============================================================================
-- 76: legal_acceptance — append-only clickwrap evidence, standard tenant RLS.
-- =============================================================================
-- SELECT + INSERT only: an acceptance is legal evidence — never edited or
-- deleted by the app role. Sentinel: legal_acceptance_insert.
-- =============================================================================

ALTER TABLE "legal_acceptance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legal_acceptance" FORCE ROW LEVEL SECURITY;

CREATE POLICY legal_acceptance_select ON "legal_acceptance" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY legal_acceptance_insert ON "legal_acceptance" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT           ON "legal_acceptance" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "legal_acceptance" FROM major_user;

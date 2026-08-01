-- =============================================================================
-- 100: data_breach_incident — GDPR Art. 33/34 breach register
-- =============================================================================
-- Tenant-scoped like everything else. NO DELETE for the app role: a breach record
-- is the evidence of when a school became aware and what it did about it, which is
-- the first thing a supervisory authority asks for. It is closed, never removed.
--
-- Sentinel: data_breach_incident_update.
-- =============================================================================

ALTER TABLE "data_breach_incident" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_breach_incident" FORCE  ROW LEVEL SECURITY;

CREATE POLICY data_breach_incident_select ON "data_breach_incident" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY data_breach_incident_insert ON "data_breach_incident" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY data_breach_incident_update ON "data_breach_incident" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "data_breach_incident" TO major_user;
REVOKE DELETE, TRUNCATE       ON "data_breach_incident" FROM major_user;

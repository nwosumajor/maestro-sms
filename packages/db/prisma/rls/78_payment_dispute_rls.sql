-- =============================================================================
-- 78: payment_dispute — gateway chargeback/dispute records.
-- =============================================================================
-- Standard tenant RLS. FINANCIAL RECORD: the app role may SELECT/INSERT/UPDATE
-- (webhook creates + resolves, staff record their response) but NEVER DELETE —
-- dispute history is permanent, like payments. Sentinel: payment_dispute_update.
-- =============================================================================

ALTER TABLE "payment_dispute" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_dispute" FORCE ROW LEVEL SECURITY;

CREATE POLICY payment_dispute_select ON "payment_dispute" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY payment_dispute_insert ON "payment_dispute" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY payment_dispute_update ON "payment_dispute" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON "payment_dispute" TO major_user;
REVOKE DELETE, TRUNCATE ON "payment_dispute" FROM major_user;

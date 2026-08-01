-- =============================================================================
-- 101: mobile_money_intent — pending mobile-money charges
-- =============================================================================
-- Tenant-scoped like every other financial record. NO DELETE for the app role: an
-- intent is the record of what a payer was asked for, which is the first thing
-- anyone wants in a payment dispute. It is marked FAILED or EXPIRED, never removed.
--
-- NOTE on the callback path: the @Public callback runs WITHOUT a tenant GUC (it
-- has no session), so it resolves the school from the intent using the PRIVILEGED
-- client and only then opens a tenant transaction — the same shape the Paystack
-- webhook uses. RLS is therefore intact for every app-role read.
--
-- Sentinel: mobile_money_intent_update.
-- =============================================================================

ALTER TABLE "mobile_money_intent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mobile_money_intent" FORCE  ROW LEVEL SECURITY;

CREATE POLICY mobile_money_intent_select ON "mobile_money_intent" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY mobile_money_intent_insert ON "mobile_money_intent" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY mobile_money_intent_update ON "mobile_money_intent" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "mobile_money_intent" TO major_user;
REVOKE DELETE, TRUNCATE       ON "mobile_money_intent" FROM major_user;

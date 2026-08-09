-- ============================================================================
-- 89: payment_channel_config — GLOBAL (cross-tenant) payment-rail switchboard.
-- ============================================================================
-- Same posture as platform_fee_config (rls/71) and plan_price (rls/46): no
-- schoolId, identical for every tenant, no tenant data. RLS on with a single
-- permissive SELECT policy — the least-privilege app role READS it on every
-- payment initiation and has NO write grant. The operator PUT writes through
-- the PRIVILEGED client (step-up gated + audited).
-- Sentinel policy: payment_channel_config_select.
-- ============================================================================

ALTER TABLE "payment_channel_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_channel_config" FORCE ROW LEVEL SECURITY;

GRANT SELECT ON "payment_channel_config" TO major_user;

CREATE POLICY payment_channel_config_select ON "payment_channel_config" FOR SELECT
  USING (true);

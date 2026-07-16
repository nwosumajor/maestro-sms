-- ============================================================================
-- 71: platform_fee_config — GLOBAL (cross-tenant) platform take-rate config.
-- ============================================================================
-- Same posture as plan_price (rls/46): no schoolId, identical for every tenant,
-- no tenant data. RLS enabled with a single permissive SELECT policy; the
-- least-privilege app role can READ (fee computation at payment init) but has
-- NO write grant — the operator PUT writes through the PRIVILEGED client
-- (step-up gated + audited). Sentinel policy: platform_fee_config_select.
-- ============================================================================

ALTER TABLE "platform_fee_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_fee_config" FORCE ROW LEVEL SECURITY;

GRANT SELECT ON "platform_fee_config" TO major_user;

CREATE POLICY platform_fee_config_select ON "platform_fee_config" FOR SELECT
  USING (true);

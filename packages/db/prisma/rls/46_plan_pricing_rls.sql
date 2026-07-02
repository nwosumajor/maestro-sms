-- ============================================================================
-- 46: plan_price — GLOBAL (cross-tenant) pricing registry. RLS posture:
-- ============================================================================
-- This table is deliberately RLS-EXEMPT in the tenant sense (no schoolId): it
-- holds the platform's per-tier pricing, identical for every tenant and free of
-- tenant data. Like the `school`/`role` registries, it is explicitly listed
-- here rather than left implicit.
--
-- Posture:
--   * RLS ENABLED with a single permissive SELECT policy (USING true) — every
--     app-role query may READ pricing (quotes, checkout, the public page).
--   * NO insert/update/delete policy and NO write GRANT for the app role: the
--     least-privilege app role CANNOT change prices. Writes go only through the
--     PRIVILEGED client (operator console PUT — step-up gated + audited), whose
--     role bypasses RLS.
-- ============================================================================

ALTER TABLE "plan_price" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_price" FORCE ROW LEVEL SECURITY;

GRANT SELECT ON "plan_price" TO major_user;

-- Read-only for everyone; the sentinel policy for docker-entrypoint idempotency.
CREATE POLICY plan_price_select ON "plan_price" FOR SELECT
  USING (true);

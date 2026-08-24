-- ============================================================================
-- 111: module_addon_price — GLOBAL add-on pricing registry. RLS posture:
-- ============================================================================
-- Identical to 46 (plan_price), deliberately: it holds platform pricing,
-- identical for every tenant and free of tenant data.
--
--   * RLS ENABLED with one permissive SELECT policy (USING true) — every
--     app-role query may READ a price (quotes, checkout, renewal).
--   * NO insert/update/delete policy and NO write GRANT: the least-privilege
--     app role CANNOT change prices. Writes go only through the PRIVILEGED
--     client (operator PUT — step-up gated + audited), whose role bypasses RLS.
-- ============================================================================

ALTER TABLE "module_addon_price" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "module_addon_price" FORCE ROW LEVEL SECURITY;

GRANT SELECT ON "module_addon_price" TO major_user;

CREATE POLICY module_addon_price_select ON "module_addon_price" FOR SELECT USING (true);

-- ============================================================================
-- 72: promo_code / agent / agent_commission — GLOBAL platform business data.
-- ============================================================================
-- Same family as plan_price (rls/46): no schoolId, no tenant PII. Postures:
--   promo_code       — app role SELECT only (checkout validates a quoted code);
--                      writes via the PRIVILEGED client (operator, audited).
--   agent            — app role SELECT only (public onboarding may echo the
--                      agent name later); writes privileged.
--   agent_commission — NO app-role access at all: it is the platform's money
--                      ledger, read and written exclusively by the privileged
--                      client (operator console). RLS enabled with no policy =
--                      deny-all for the app role.
-- Sentinel policy for the entrypoint guard: agent_select.
-- ============================================================================

ALTER TABLE "promo_code" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promo_code" FORCE ROW LEVEL SECURITY;
GRANT SELECT ON "promo_code" TO major_user;
CREATE POLICY promo_code_select ON "promo_code" FOR SELECT USING (true);

ALTER TABLE "agent_commission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_commission" FORCE ROW LEVEL SECURITY;
-- no GRANT, no policy: deny-all for the app role by design.

ALTER TABLE "agent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent" FORCE ROW LEVEL SECURITY;
GRANT SELECT ON "agent" TO major_user;
CREATE POLICY agent_select ON "agent" FOR SELECT USING (true);

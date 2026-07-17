-- ============================================================================
-- 74: school_group / school_group_member / school_group_director — GLOBAL
-- group-console registry. Deny-all for the app role (same family as
-- agent_commission): directorship grants a CROSS-TENANT read, so resolution
-- and every group query run exclusively on the PRIVILEGED client (operator
-- console pattern). RLS enabled with no policy + no grant = the least-privilege
-- role cannot even see that groups exist. Sentinel: the entrypoint guard keys
-- on rowsecurity, so we add one dummy-safe SELECT policy for the check —
-- school_group_marker — that still matches NO app-role rows (USING false).
-- ============================================================================

ALTER TABLE "school_group" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "school_group" FORCE ROW LEVEL SECURITY;
ALTER TABLE "school_group_member" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "school_group_member" FORCE ROW LEVEL SECURITY;
ALTER TABLE "school_group_director" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "school_group_director" FORCE ROW LEVEL SECURITY;

-- Entrypoint idempotency sentinel only — matches nothing, grants nothing.
CREATE POLICY school_group_marker ON "school_group" FOR SELECT USING (false);

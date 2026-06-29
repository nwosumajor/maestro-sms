-- =============================================================================
-- onboarding_request — PUBLIC pre-tenant intake (GLOBAL, no schoolId)
-- =============================================================================
-- Run AFTER the table exists, as the PRIVILEGED migration role (Golden Rule #4).
-- This row predates any tenant, so there is NO tenant dimension to scope on — it
-- is GLOBAL like school/role. We still ENABLE RLS with a single permissive policy
-- so the file has a sentinel (the entrypoint keys idempotency on the last policy
-- name) and so least-privilege is explicit: the app role is granted only
-- SELECT (for INSERT ... RETURNING) + INSERT — the public submit path. Reviewing /
-- updating a request is done by the super_admin via the PRIVILEGED client (which
-- bypasses RLS as the table owner), never by the app role.
--
-- Not subject to the RLS coverage gate: that gate only flags tables that carry a
-- schoolId column; this one has none by design.
-- =============================================================================

ALTER TABLE "onboarding_request" ENABLE ROW LEVEL SECURITY;

-- Permissive (global): no tenant to scope on. Grants below restrict the app role
-- to SELECT/INSERT, so UPDATE/DELETE are denied at the privilege level anyway.
CREATE POLICY onboarding_request_all ON "onboarding_request" FOR ALL
  USING (true) WITH CHECK (true);

GRANT  SELECT, INSERT           ON "onboarding_request" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "onboarding_request" FROM major_user;

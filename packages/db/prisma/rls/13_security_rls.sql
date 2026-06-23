-- =============================================================================
-- Security RLS + grants
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md). Run AFTER migration
-- 20260620160000_security, as the PRIVILEGED migration role.
--
-- privilege_grant is tenant-scoped; same fail-closed predicate as the rest.
-- Who may request/approve/view is enforced in SecurityService ON TOP of this.
-- Grants are an audit record of access decisions and are never hard-deleted
-- (revocation is a status change): no DELETE policy/grant. Sentinel for the
-- entrypoint guard = LAST policy: privilege_grant_update.
-- =============================================================================

ALTER TABLE "privilege_grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "privilege_grant" FORCE  ROW LEVEL SECURITY;

CREATE POLICY privilege_grant_select ON "privilege_grant" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY privilege_grant_insert ON "privilege_grant" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY privilege_grant_update ON "privilege_grant" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "privilege_grant" TO major_user;
REVOKE DELETE, TRUNCATE       ON "privilege_grant" FROM major_user;

-- =============================================================================
-- Approval Workflow RLS + grants
-- =============================================================================
-- workflow_request: tenant-scoped read/write. workflow_audit_log: APPEND-ONLY
-- (INSERT/SELECT only, privileges revoked) so the transition trail is immutable.
-- Run as the privileged migration role. Adjust `major_user` if it differs.
-- =============================================================================

-- workflow_request --------------------------------------------------------------
ALTER TABLE "workflow_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_request" FORCE  ROW LEVEL SECURITY;
CREATE POLICY wr_select ON "workflow_request" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY wr_insert ON "workflow_request" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY wr_update ON "workflow_request" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "workflow_request" TO major_user;

-- workflow_audit_log (APPEND-ONLY) ---------------------------------------------
ALTER TABLE "workflow_audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_audit_log" FORCE  ROW LEVEL SECURITY;
CREATE POLICY wal_select ON "workflow_audit_log" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY wal_insert ON "workflow_audit_log" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT           ON "workflow_audit_log" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "workflow_audit_log" FROM major_user;

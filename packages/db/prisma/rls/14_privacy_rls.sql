-- =============================================================================
-- Privacy RLS + grants
-- =============================================================================
-- Run AFTER migration 20260620190000_privacy, as the PRIVILEGED migration role.
-- erasure_request is tenant-scoped; who may raise/review is enforced in
-- PrivacyService. Requests are an audit trail of rights exercised; not deleted
-- (a decision is a status change). Sentinel = LAST policy: erasure_request_update.
-- =============================================================================

ALTER TABLE "erasure_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "erasure_request" FORCE  ROW LEVEL SECURITY;

CREATE POLICY erasure_request_select ON "erasure_request" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY erasure_request_insert ON "erasure_request" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY erasure_request_update ON "erasure_request" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "erasure_request" TO major_user;
REVOKE DELETE, TRUNCATE       ON "erasure_request" FROM major_user;

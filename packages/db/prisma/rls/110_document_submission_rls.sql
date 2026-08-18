-- =============================================================================
-- 110: document_submission — a child's birth certificate, a candidate's CV
-- =============================================================================
-- The most sensitive table added in a while, and the posture is set accordingly.
--
-- SELECT/INSERT/UPDATE are tenant-scoped as everywhere else. What is different
-- is DELETE: the app role has NONE.
--
-- These rows are identity documents about minors and job applicants. Two things
-- follow. First, a rejected application's files must eventually GO — keeping a
-- birth certificate for a family the school turned down is the thing to avoid —
-- but that removal is a scheduled, cross-tenant retention sweep running on the
-- PRIVILEGED client, exactly like the integrity telemetry purge; it is not
-- something a request path should be able to do. Second, nothing in the normal
-- flow deletes: a file that should not have been sent is REJECTED with a reason
-- and superseded, which leaves the trail of what was supplied and who judged it.
--
-- A registrar wanting rid of a file today is a request for the retention window,
-- not for a DELETE grant. The absence of the grant is the enforcement.
--
-- Sentinel: document_submission_update.
-- =============================================================================

ALTER TABLE "document_submission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_submission" FORCE  ROW LEVEL SECURITY;

CREATE POLICY document_submission_select ON "document_submission" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY document_submission_insert ON "document_submission" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY document_submission_update ON "document_submission" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

-- No DELETE policy and no DELETE grant: see above.
GRANT  SELECT, INSERT, UPDATE ON "document_submission" TO major_user;
REVOKE DELETE, TRUNCATE       ON "document_submission" FROM major_user;

-- ============================================================================
-- 102: job_run — GLOBAL background-job history. RLS posture:
-- ============================================================================
-- Deliberately RLS-EXEMPT in the tenant sense (no schoolId), and listed here
-- explicitly rather than left implicit, like `school`, `role` and `plan_price`.
--
-- These jobs run ACROSS every tenant — dunning, payment reconciliation,
-- mobile-money recovery, retention purges — so a run belongs to no one school.
-- The rows carry no tenant data: a job name, a timestamp, and the job's own
-- result counts.
--
-- Posture:
--   * RLS ENABLED with a single permissive SELECT policy — the operator console
--     reads it through the app role.
--   * NO insert/update/delete policy and NO write GRANT: the least-privilege app
--     role CANNOT forge or erase a job's history. Writes go only through the
--     PRIVILEGED client, which the schedulers already use, and whose role
--     bypasses RLS. A job history an ordinary request could rewrite would be
--     worth nothing as evidence that a sweep ran.
-- ============================================================================

ALTER TABLE "job_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_run" FORCE ROW LEVEL SECURITY;

GRANT SELECT ON "job_run" TO major_user;

CREATE POLICY job_run_select ON "job_run" FOR SELECT
  USING (true);

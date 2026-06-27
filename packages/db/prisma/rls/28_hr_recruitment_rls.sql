-- =============================================================================
-- HR recruitment RLS + grants (job requisitions + applicants)
-- =============================================================================
-- Run AFTER migration 20260627*_hr_recruitment_leave_attachment, as the PRIVILEGED
-- role. Tenant-scoped; WHO may act is enforced in RecruitmentService
-- (hr.recruit.manage). No hard delete. Sentinel = LAST policy: applicant_update.
-- =============================================================================

-- job_requisition -------------------------------------------------------------
ALTER TABLE "job_requisition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_requisition" FORCE  ROW LEVEL SECURITY;
CREATE POLICY job_requisition_select ON "job_requisition" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY job_requisition_insert ON "job_requisition" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY job_requisition_update ON "job_requisition" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "job_requisition" TO major_user;
REVOKE DELETE, TRUNCATE       ON "job_requisition" FROM major_user;

-- applicant -------------------------------------------------------------------
ALTER TABLE "applicant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "applicant" FORCE  ROW LEVEL SECURITY;
CREATE POLICY applicant_select ON "applicant" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY applicant_insert ON "applicant" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY applicant_update ON "applicant" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "applicant" TO major_user;
REVOKE DELETE, TRUNCATE       ON "applicant" FROM major_user;

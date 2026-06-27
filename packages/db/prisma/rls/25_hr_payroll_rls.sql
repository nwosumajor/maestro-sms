-- =============================================================================
-- HR leave / salary-history / payroll RLS + grants
-- =============================================================================
-- Run AFTER migration 20260627144259_hr_leave_salary_payroll_workflow_stages, as
-- the PRIVILEGED role. All six tables are tenant-scoped; WHO may read/write is
-- enforced in the HR services (hr.* + the staged workflow). Records are not hard-
-- deleted (history/audit posture) → no DELETE. Sentinel = LAST policy: payslip_insert.
-- =============================================================================

-- leave_type ------------------------------------------------------------------
ALTER TABLE "leave_type" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_type" FORCE  ROW LEVEL SECURITY;
CREATE POLICY leave_type_select ON "leave_type" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY leave_type_insert ON "leave_type" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY leave_type_update ON "leave_type" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "leave_type" TO major_user;
REVOKE DELETE, TRUNCATE       ON "leave_type" FROM major_user;

-- leave_balance ---------------------------------------------------------------
ALTER TABLE "leave_balance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_balance" FORCE  ROW LEVEL SECURITY;
CREATE POLICY leave_balance_select ON "leave_balance" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY leave_balance_insert ON "leave_balance" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY leave_balance_update ON "leave_balance" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "leave_balance" TO major_user;
REVOKE DELETE, TRUNCATE       ON "leave_balance" FROM major_user;

-- leave_request ---------------------------------------------------------------
ALTER TABLE "leave_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_request" FORCE  ROW LEVEL SECURITY;
CREATE POLICY leave_request_select ON "leave_request" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY leave_request_insert ON "leave_request" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY leave_request_update ON "leave_request" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "leave_request" TO major_user;
REVOKE DELETE, TRUNCATE       ON "leave_request" FROM major_user;

-- salary_change_request (append-only history; decided in place) ----------------
ALTER TABLE "salary_change_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salary_change_request" FORCE  ROW LEVEL SECURITY;
CREATE POLICY salary_change_request_select ON "salary_change_request" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY salary_change_request_insert ON "salary_change_request" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY salary_change_request_update ON "salary_change_request" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "salary_change_request" TO major_user;
REVOKE DELETE, TRUNCATE       ON "salary_change_request" FROM major_user;

-- payroll_run -----------------------------------------------------------------
ALTER TABLE "payroll_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_run" FORCE  ROW LEVEL SECURITY;
CREATE POLICY payroll_run_select ON "payroll_run" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY payroll_run_insert ON "payroll_run" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY payroll_run_update ON "payroll_run" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "payroll_run" TO major_user;
REVOKE DELETE, TRUNCATE       ON "payroll_run" FROM major_user;

-- payslip (created during a run; not edited afterwards) ------------------------
ALTER TABLE "payslip" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payslip" FORCE  ROW LEVEL SECURITY;
CREATE POLICY payslip_select ON "payslip" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY payslip_insert ON "payslip" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT ON "payslip" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "payslip" FROM major_user;

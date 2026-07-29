-- Indexes for the unified approvals inbox (GET /approvals/pending).
--
-- The inbox asks each module "what is pending a decision?" on every page load.
-- Six of those tables had no status index, so the lookup was a full scan that
-- degrades as the table grows. `payment` is the acute one — it accumulates every
-- fee payment ever recorded, while only a handful are ever PENDING_APPROVAL.
--
-- Shape matches the tables that already got this right (invoice_adjustment,
-- admission_application, erasure_request): a plain (schoolId, status) btree,
-- which is also RLS-friendly since every query is already tenant-scoped.
--
-- IDEMPOTENT (IF NOT EXISTS): an index-only migration must be safely re-runnable.
-- One of these indexes already existed on a live DB, so a plain CREATE INDEX
-- aborted the whole migration and then BLOCKED every later migration behind it.

CREATE INDEX IF NOT EXISTS "payment_schoolId_status_idx" ON "payment"("schoolId", "status");
CREATE INDEX IF NOT EXISTS "salary_change_request_schoolId_status_idx" ON "salary_change_request"("schoolId", "status");
CREATE INDEX IF NOT EXISTS "staff_loan_schoolId_status_idx" ON "staff_loan"("schoolId", "status");
CREATE INDEX IF NOT EXISTS "staff_exit_schoolId_status_idx" ON "staff_exit"("schoolId", "status");
CREATE INDEX IF NOT EXISTS "employment_change_request_schoolId_status_idx" ON "employment_change_request"("schoolId", "status");
CREATE INDEX IF NOT EXISTS "payroll_run_schoolId_status_idx" ON "payroll_run"("schoolId", "status");

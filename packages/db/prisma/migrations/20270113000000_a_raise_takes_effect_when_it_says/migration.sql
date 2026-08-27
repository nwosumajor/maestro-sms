-- A salary change carries an effectiveDate that NOTHING consulted.
--
-- The approval applied `employee.salaryEnc` immediately and unconditionally, so
-- a raise requested "effective 1 October" and approved on 27 August moved the
-- salary on 27 August — five weeks early, and the next payroll run paid it.
-- Proven live: status APPROVED, effectiveDate 2026-10-01, decidedAt 2026-08-27,
-- employee row updated the same day.
--
-- `appliedAt` records WHEN the new figure actually reached the employee, so an
-- approval can be deferred to its own date and the nightly sweep can apply it
-- exactly once. NULL on an approved row means "approved, not yet in force".
ALTER TABLE "salary_change_request" ADD COLUMN "appliedAt" TIMESTAMP(3);

-- Backfill: every APPROVED row in existence was applied at the moment it was
-- decided, because that is what the old code did. Recording that is what stops
-- the new sweep re-applying historical changes on its first run.
UPDATE "salary_change_request" SET "appliedAt" = "decidedAt" WHERE status = 'APPROVED' AND "decidedAt" IS NOT NULL;

-- The sweep asks for APPROVED rows that are due and not yet applied.
CREATE INDEX "salary_change_request_pending_effect_idx"
  ON "salary_change_request" ("effectiveDate")
  WHERE status = 'APPROVED' AND "appliedAt" IS NULL;

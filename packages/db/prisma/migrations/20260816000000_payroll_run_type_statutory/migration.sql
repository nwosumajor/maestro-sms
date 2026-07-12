-- Payroll run types (monthly / 13th-month / bonus) + statutory identifiers.
-- runType widens the one-run-per-period uniqueness so a December 13th-month run
-- coexists with the December monthly run. Existing rows backfill to MONTHLY.
ALTER TABLE "payroll_run" ADD COLUMN "runType" TEXT NOT NULL DEFAULT 'MONTHLY';
ALTER TABLE "payroll_run" ADD COLUMN "bonusPercent" INTEGER;
DROP INDEX "payroll_run_schoolId_periodYear_periodMonth_key";
CREATE UNIQUE INDEX "payroll_run_schoolId_periodYear_periodMonth_runType_key"
  ON "payroll_run"("schoolId","periodYear","periodMonth","runType");

-- Employee statutory identifiers (encrypted): PAYE TIN + pension RSA PIN.
ALTER TABLE "employee" ADD COLUMN "tinEnc" TEXT;
ALTER TABLE "employee" ADD COLUMN "rsaPinEnc" TEXT;

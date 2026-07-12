-- Exit management: staff_exit (maker-checker settlement record) + allow
-- loan_repayment rows without a payroll run (exit-settlement recovery).
-- RLS in rls/62.
CREATE TABLE "staff_exit" (
  "id"             UUID NOT NULL,
  "schoolId"       UUID NOT NULL,
  "userId"         UUID NOT NULL,
  "type"           TEXT NOT NULL,
  "lastWorkingDay" DATE NOT NULL,
  "reason"         TEXT,
  "settlementEnc"  TEXT NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'PENDING',
  "initiatedById"  UUID NOT NULL,
  "decidedById"    UUID,
  "decidedAt"      TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "staff_exit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "staff_exit_schoolId_idx" ON "staff_exit"("schoolId");
CREATE INDEX "staff_exit_schoolId_userId_idx" ON "staff_exit"("schoolId","userId");

ALTER TABLE "loan_repayment" ALTER COLUMN "payrollRunId" DROP NOT NULL;

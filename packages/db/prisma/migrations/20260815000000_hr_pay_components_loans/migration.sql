-- Payroll depth: recurring allowances/deductions per employee, staff loans /
-- salary advances (maker-checker) with an append-only repayment ledger, and a
-- full encrypted breakdown snapshot on each payslip. RLS in rls/58.
ALTER TABLE "payslip" ADD COLUMN "breakdownEnc" TEXT;

CREATE TABLE "pay_component" (
  "id"          UUID NOT NULL,
  "schoolId"    UUID NOT NULL,
  "userId"      UUID NOT NULL,
  "kind"        TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "createdById" UUID NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pay_component_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pay_component_schoolId_idx" ON "pay_component"("schoolId");
CREATE INDEX "pay_component_schoolId_userId_idx" ON "pay_component"("schoolId","userId");

CREATE TABLE "staff_loan" (
  "id"            UUID NOT NULL,
  "schoolId"      UUID NOT NULL,
  "userId"        UUID NOT NULL,
  "purpose"       TEXT NOT NULL,
  "principalEnc"  TEXT NOT NULL,
  "monthlyEnc"    TEXT NOT NULL,
  "balanceEnc"    TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'PENDING',
  "requestedById" UUID NOT NULL,
  "decidedById"   UUID,
  "decidedAt"     TIMESTAMP(3),
  "comment"       TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "staff_loan_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "staff_loan_schoolId_idx" ON "staff_loan"("schoolId");
CREATE INDEX "staff_loan_schoolId_userId_idx" ON "staff_loan"("schoolId","userId");

CREATE TABLE "loan_repayment" (
  "id"           UUID NOT NULL,
  "schoolId"     UUID NOT NULL,
  "loanId"       UUID NOT NULL,
  "payrollRunId" UUID NOT NULL,
  "userId"       UUID NOT NULL,
  "amountEnc"    TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loan_repayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "loan_repayment_loanId_payrollRunId_key" ON "loan_repayment"("loanId","payrollRunId");
CREATE INDEX "loan_repayment_schoolId_idx" ON "loan_repayment"("schoolId");
CREATE INDEX "loan_repayment_schoolId_loanId_idx" ON "loan_repayment"("schoolId","loanId");

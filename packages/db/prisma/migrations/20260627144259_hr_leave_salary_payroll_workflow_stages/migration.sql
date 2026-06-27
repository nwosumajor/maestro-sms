-- Multi-stage approval chain on workflow requests
ALTER TABLE "workflow_request" ADD COLUMN     "currentStage" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stages" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "approvals" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "leave_type" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "daysPerYear" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balance" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "leaveTypeId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "entitledDays" INTEGER NOT NULL DEFAULT 0,
    "usedDays" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_request" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "leaveTypeId" UUID NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "days" INTEGER NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_change_request" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "oldSalaryEnc" TEXT,
    "newSalaryEnc" TEXT,
    "reason" TEXT,
    "effectiveDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" UUID NOT NULL,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_change_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_run" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "totalGrossMinor" INTEGER NOT NULL DEFAULT 0,
    "totalNetMinor" INTEGER NOT NULL DEFAULT 0,
    "runById" UUID NOT NULL,
    "finalizedById" UUID,
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "grossEnc" TEXT,
    "deductionsEnc" TEXT,
    "netEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leave_type_schoolId_idx" ON "leave_type"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_type_schoolId_name_key" ON "leave_type"("schoolId", "name");

-- CreateIndex
CREATE INDEX "leave_balance_schoolId_idx" ON "leave_balance"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_balance_schoolId_userId_leaveTypeId_year_key" ON "leave_balance"("schoolId", "userId", "leaveTypeId", "year");

-- CreateIndex
CREATE INDEX "leave_request_schoolId_idx" ON "leave_request"("schoolId");

-- CreateIndex
CREATE INDEX "leave_request_schoolId_userId_idx" ON "leave_request"("schoolId", "userId");

-- CreateIndex
CREATE INDEX "salary_change_request_schoolId_idx" ON "salary_change_request"("schoolId");

-- CreateIndex
CREATE INDEX "salary_change_request_schoolId_employeeId_idx" ON "salary_change_request"("schoolId", "employeeId");

-- CreateIndex
CREATE INDEX "payroll_run_schoolId_idx" ON "payroll_run"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_run_schoolId_periodYear_periodMonth_key" ON "payroll_run"("schoolId", "periodYear", "periodMonth");

-- CreateIndex
CREATE INDEX "payslip_schoolId_idx" ON "payslip"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "payslip_payrollRunId_userId_key" ON "payslip"("payrollRunId", "userId");

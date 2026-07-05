-- CreateEnum
CREATE TYPE "ScholarshipProgramStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ScholarshipAwardKind" AS ENUM ('FEES_CREDIT', 'SUBSCRIPTION_CREDIT');

-- CreateEnum
CREATE TYPE "ScholarshipSelectionBasis" AS ENUM ('MERIT', 'NEED', 'BOTH');

-- CreateEnum
CREATE TYPE "ScholarshipApplicationStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'SHORTLISTED', 'AWARDED', 'REJECTED');

-- AlterEnum: platform-sponsored scholarship credit on the Fees ledger.
ALTER TYPE "PaymentKind" ADD VALUE 'SCHOLARSHIP';

-- CreateTable
CREATE TABLE "scholarship_program" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "budgetMinor" INTEGER NOT NULL DEFAULT 0,
    "awardMinor" INTEGER NOT NULL,
    "awardKind" "ScholarshipAwardKind" NOT NULL DEFAULT 'FEES_CREDIT',
    "selectionBasis" "ScholarshipSelectionBasis" NOT NULL DEFAULT 'BOTH',
    "eligibility" JSONB,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "status" "ScholarshipProgramStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scholarship_program_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scholarship_application" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "programId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "applicantId" UUID NOT NULL,
    "applicantRole" TEXT NOT NULL,
    "answers" JSONB,
    "signals" JSONB,
    "status" "ScholarshipApplicationStatus" NOT NULL DEFAULT 'DRAFT',
    "consentById" UUID,
    "consentAt" TIMESTAMP(3),
    "awardMinor" INTEGER,
    "reviewedById" UUID,
    "reviewNote" TEXT,
    "disbursementPaymentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scholarship_application_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scholarship_program_status_idx" ON "scholarship_program"("status");

-- CreateIndex
CREATE INDEX "scholarship_application_schoolId_idx" ON "scholarship_application"("schoolId");

-- CreateIndex
CREATE INDEX "scholarship_application_schoolId_status_idx" ON "scholarship_application"("schoolId", "status");

-- CreateIndex
CREATE INDEX "scholarship_application_programId_status_idx" ON "scholarship_application"("programId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "scholarship_application_programId_studentId_key" ON "scholarship_application"("programId", "studentId");

-- AddForeignKey
ALTER TABLE "scholarship_application" ADD CONSTRAINT "scholarship_application_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

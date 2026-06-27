-- Leave attachment (Document Vault link)
ALTER TABLE "leave_request" ADD COLUMN "attachmentDocId" UUID;

-- CreateTable
CREATE TABLE "job_requisition" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "department" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "openings" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_requisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applicant" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "requisitionId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'APPLIED',
    "notes" TEXT,
    "convertedUserId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applicant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_requisition_schoolId_idx" ON "job_requisition"("schoolId");

-- CreateIndex
CREATE INDEX "applicant_schoolId_idx" ON "applicant"("schoolId");

-- CreateIndex
CREATE INDEX "applicant_schoolId_requisitionId_idx" ON "applicant"("schoolId", "requisitionId");


-- Bulk SIS student import with maker-checker. A staged batch holds PENDING rows
-- (nothing created yet); a DIFFERENT authorized person approves to create the
-- student accounts + profiles. Tenant-scoped; RLS + grants in
-- prisma/rls/32_student_import_rls.sql (applied separately).

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "student_import_batch" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PENDING',
    "uploadedById" UUID NOT NULL,
    "reviewedById" UUID,
    "rows" JSONB NOT NULL,
    "summary" JSONB,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_import_batch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "student_import_batch_schoolId_idx" ON "student_import_batch"("schoolId");
CREATE INDEX "student_import_batch_schoolId_status_idx" ON "student_import_batch"("schoolId", "status");
ALTER TABLE "student_import_batch" ADD CONSTRAINT "student_import_batch_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

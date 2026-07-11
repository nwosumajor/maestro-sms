-- LMS per-student content completion (mark-as-complete / progress). Tenant-scoped.
-- CreateTable
CREATE TABLE "lms_progress" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lms_progress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lms_progress_contentId_studentId_key" ON "lms_progress"("contentId", "studentId");
CREATE INDEX "lms_progress_schoolId_idx" ON "lms_progress"("schoolId");
CREATE INDEX "lms_progress_schoolId_contentId_idx" ON "lms_progress"("schoolId", "contentId");

-- LMS assignment submissions (student text submission + staff grade/feedback). Tenant-scoped.
-- CreateTable
CREATE TABLE "lms_submission" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "late" BOOLEAN NOT NULL DEFAULT false,
    "grade" INTEGER,
    "feedback" TEXT,
    "gradedById" UUID,
    "gradedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lms_submission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lms_submission_contentId_studentId_key" ON "lms_submission"("contentId", "studentId");
CREATE INDEX "lms_submission_schoolId_idx" ON "lms_submission"("schoolId");
CREATE INDEX "lms_submission_schoolId_contentId_idx" ON "lms_submission"("schoolId", "contentId");

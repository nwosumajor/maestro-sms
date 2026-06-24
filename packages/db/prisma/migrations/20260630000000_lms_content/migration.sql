-- LMS learning content (materials / lessons / quizzes / forum threads) — JSONB
-- bodies, approval-gated publication. Tenant-scoped; RLS in 23_lms_content_rls.sql
-- (applied separately). See schema/lms_content.prisma.

CREATE TABLE "lms_content" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "authorId" UUID NOT NULL,
    "approvalRequestId" UUID,
    "fileKey" TEXT,
    "fileName" TEXT,
    "fileUploaded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lms_content_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lms_content_schoolId_idx" ON "lms_content"("schoolId");
CREATE INDEX "lms_content_schoolId_classId_idx" ON "lms_content"("schoolId", "classId");

CREATE TABLE "quiz_attempt" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "score" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quiz_attempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "quiz_attempt_contentId_studentId_key" ON "quiz_attempt"("contentId", "studentId");
CREATE INDEX "quiz_attempt_schoolId_idx" ON "quiz_attempt"("schoolId");
CREATE INDEX "quiz_attempt_schoolId_contentId_idx" ON "quiz_attempt"("schoolId", "contentId");

CREATE TABLE "forum_post" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "forum_post_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "forum_post_schoolId_idx" ON "forum_post"("schoolId");
CREATE INDEX "forum_post_schoolId_contentId_idx" ON "forum_post"("schoolId", "contentId");

ALTER TABLE "lms_content" ADD CONSTRAINT "lms_content_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lms_content" ADD CONSTRAINT "lms_content_classId_fkey" FOREIGN KEY ("classId") REFERENCES "class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lms_content" ADD CONSTRAINT "lms_content_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quiz_attempt" ADD CONSTRAINT "quiz_attempt_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quiz_attempt" ADD CONSTRAINT "quiz_attempt_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "lms_content"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quiz_attempt" ADD CONSTRAINT "quiz_attempt_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "forum_post" ADD CONSTRAINT "forum_post_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "forum_post" ADD CONSTRAINT "forum_post_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "lms_content"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "forum_post" ADD CONSTRAINT "forum_post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Achievement badges: a teacher awards positive recognition to a student.
-- Tenant-scoped; RLS in rls/56.
CREATE TABLE "lms_award" (
  "id"          UUID NOT NULL,
  "schoolId"    UUID NOT NULL,
  "classId"     UUID NOT NULL,
  "studentId"   UUID NOT NULL,
  "badge"       TEXT NOT NULL,
  "note"        TEXT,
  "awardedById" UUID NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lms_award_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lms_award_schoolId_idx" ON "lms_award"("schoolId");
CREATE INDEX "lms_award_schoolId_classId_idx" ON "lms_award"("schoolId","classId");
CREATE INDEX "lms_award_schoolId_studentId_idx" ON "lms_award"("schoolId","studentId");

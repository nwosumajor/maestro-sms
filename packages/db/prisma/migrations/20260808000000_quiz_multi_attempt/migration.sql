-- Allow multiple quiz attempts per student: drop the (contentId, studentId) unique,
-- add a 1-based attemptNo, and a non-unique index for lookups.
DROP INDEX "quiz_attempt_contentId_studentId_key";
ALTER TABLE "quiz_attempt" ADD COLUMN "attemptNo" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "quiz_attempt_contentId_studentId_idx" ON "quiz_attempt"("contentId", "studentId");

-- Essay (manual-graded) quiz questions: attempt status + per-essay grades.
ALTER TABLE "quiz_attempt" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'GRADED';
ALTER TABLE "quiz_attempt" ADD COLUMN "essayGrades" JSONB NOT NULL DEFAULT '{}';

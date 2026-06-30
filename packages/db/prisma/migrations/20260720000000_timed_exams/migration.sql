-- Timed online exams: window + duration on assessment, start time on submission.
-- Nullable/defaulted — existing untimed assignments are unaffected. No new RLS.
ALTER TABLE "assessment" ADD COLUMN "timed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "assessment" ADD COLUMN "durationMinutes" INTEGER;
ALTER TABLE "assessment" ADD COLUMN "opensAt" TIMESTAMP(3);
ALTER TABLE "assessment" ADD COLUMN "closesAt" TIMESTAMP(3);
ALTER TABLE "submission" ADD COLUMN "startedAt" TIMESTAMP(3);

-- Bind scholarship qualification exams to real platform sessions:
--   ONLINE_CBT -> per-school CBT exams materialized from the program's question
--                 set; GAMES -> one cross-school Ultimate arena competition.
-- Plus per-position (1st/2nd/3rd) award amounts and the exam-score signal.

ALTER TABLE "scholarship_program" ADD COLUMN "award2Minor" INTEGER;
ALTER TABLE "scholarship_program" ADD COLUMN "award3Minor" INTEGER;
ALTER TABLE "scholarship_program" ADD COLUMN "examDurationMin" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "scholarship_program" ADD COLUMN "examQuestions" JSONB;

ALTER TABLE "scholarship_application" ADD COLUMN "examScorePct" DOUBLE PRECISION;
ALTER TABLE "scholarship_application" ADD COLUMN "awardPosition" INTEGER;

ALTER TABLE "cbt_exam" ADD COLUMN "scholarshipProgramId" UUID;
ALTER TABLE "ultimate_competition" ADD COLUMN "scholarshipProgramId" UUID;

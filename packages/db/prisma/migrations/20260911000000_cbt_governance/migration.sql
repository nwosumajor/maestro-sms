-- CBT governance: teacher subject scoping + publish maker-checker + gated
-- answer-key release. New columns only — no new tables, so no new RLS file
-- (the existing rls/75_cbt_rls.sql policies cover these rows).
--   cbt_question_bank.subjectId       — curriculum Subject link (teacher scoping)
--   cbt_exam.answerRelease            — HIDDEN | REQUESTED | RELEASED
--   cbt_exam.answersReleasedAt        — stamped when the principal approves

ALTER TABLE "cbt_question_bank" ADD COLUMN "subjectId" UUID;

ALTER TABLE "cbt_exam" ADD COLUMN "answerRelease" TEXT NOT NULL DEFAULT 'HIDDEN';
ALTER TABLE "cbt_exam" ADD COLUMN "answersReleasedAt" TIMESTAMP(3);

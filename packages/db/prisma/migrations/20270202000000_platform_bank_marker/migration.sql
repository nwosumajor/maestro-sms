-- A scholarship paper is MATERIALISED as a question bank inside each
-- candidate's own school, which is what keeps every sitting RLS-scoped. The
-- exam row carries `scholarshipProgramId` and is guarded by
-- `assertNotAPlatformExam`; the BANK carried no marker at all, so the school's
-- own bank list showed it and `GET /cbt/banks/:id/questions` returned its
-- questions WITH `answerIndex` to school-wide staff.
--
-- Measured live: the candidate's own principal and school_admin read
-- `ANSWER KEY: [1,0]` for a cross-school paper before their pupil sat it —
-- the same leak `assertNotAPlatformExam` exists to prevent, through a door
-- that fix did not close.
--
-- A COLUMN rather than a join through `cbt_exam`: a bank whose exam is gone is
-- still a platform paper holding a platform answer key, and deriving the fact
-- would lose it exactly then.
ALTER TABLE "cbt_question_bank" ADD COLUMN IF NOT EXISTS "scholarshipProgramId" UUID;

-- Backfill from the exams that draw on them, which is the link that existed.
UPDATE "cbt_question_bank" b
   SET "scholarshipProgramId" = e."scholarshipProgramId"
  FROM "cbt_exam" e
 WHERE e."bankId" = b.id
   AND e."scholarshipProgramId" IS NOT NULL
   AND b."scholarshipProgramId" IS NULL;

-- Belt and braces for a bank whose exam has since gone: the announce names it
-- "Scholarship: …", and such a bank is platform-owned whatever else is true.
UPDATE "cbt_question_bank"
   SET "scholarshipProgramId" = '00000000-0000-0000-0000-000000000000'
 WHERE "scholarshipProgramId" IS NULL AND name LIKE 'Scholarship: %';

CREATE INDEX IF NOT EXISTS "cbt_question_bank_scholarshipProgramId_idx"
    ON "cbt_question_bank" ("scholarshipProgramId");

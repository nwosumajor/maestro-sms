-- Question BANKS, the way the CBT module already works.
--
-- The library shipped as a flat list of questions each carrying a subject
-- string. That is enough to reuse a question and not enough to WORK: an owner
-- builds a paper of sixty to a hundred questions for one subject in a sitting,
-- and needs somewhere to build it, correct it, and then declare it finished.
--
-- A bank is that place, and STATUS is what makes it one: a bank being written
-- is DRAFT and cannot be drawn on, so a half-written paper can never reach a
-- candidate. "Save bank" is the moment it becomes READY.
CREATE TABLE IF NOT EXISTS "scholarship_question_bank" (
  "id"          UUID PRIMARY KEY,
  "name"        TEXT NOT NULL,
  -- A SUBJECT_CONCEPTS key. The comparability anchor the subject catalogue
  -- already uses, so a bank means the same thing whatever curriculum a school
  -- follows — a scholarship spans schools on several.
  "subjectCode" TEXT NOT NULL,
  "subjectName" TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'DRAFT',
  "createdById" UUID NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "scholarship_question_bank_subject_idx"
  ON "scholarship_question_bank" ("subjectCode", "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "scholarship_question_bank_createdAt_idx"
  ON "scholarship_question_bank" ("createdAt" DESC, "id" DESC);

ALTER TABLE "scholarship_question" ADD COLUMN IF NOT EXISTS "bankId" UUID;

-- BACKFILL BEFORE THE CONSTRAINT, one bank per distinct subject already in the
-- library, so a deployment that has questions keeps every one of them. They are
-- created READY: they were written before banks existed and refusing to draw on
-- them would be this change taking something away.
INSERT INTO "scholarship_question_bank" ("id","name","subjectCode","subjectName","status","createdById","createdAt","updatedAt")
SELECT gen_random_uuid(), q.subject || ' (existing questions)', 'UNCODED', q.subject, 'READY',
       -- NOT min(): Postgres has no min(uuid). Any one of the authors will do
       -- as the bank's creator, and array_agg picks one without a cast.
       (array_agg(q."createdById"))[1], now(), now()
  FROM "scholarship_question" q
 WHERE q."bankId" IS NULL
 GROUP BY q.subject;

UPDATE "scholarship_question" q
   SET "bankId" = b.id
  FROM "scholarship_question_bank" b
 WHERE q."bankId" IS NULL AND b."subjectName" = q.subject AND b."subjectCode" = 'UNCODED';

ALTER TABLE "scholarship_question" ALTER COLUMN "bankId" SET NOT NULL;

-- ON DELETE CASCADE: a bank IS its questions. Deleting one and orphaning a
-- hundred rows nothing can reach would be worse than either outcome.
-- Dropped first so the whole file is safe to re-run: `ADD CONSTRAINT` has no
-- IF NOT EXISTS, and a migration that cannot be replayed is one nobody can
-- recover a database with.
ALTER TABLE "scholarship_question" DROP CONSTRAINT IF EXISTS "scholarship_question_bankId_fkey";
ALTER TABLE "scholarship_question"
  ADD CONSTRAINT "scholarship_question_bankId_fkey"
  FOREIGN KEY ("bankId") REFERENCES "scholarship_question_bank"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "scholarship_question_bankId_idx"
  ON "scholarship_question" ("bankId", "createdAt");

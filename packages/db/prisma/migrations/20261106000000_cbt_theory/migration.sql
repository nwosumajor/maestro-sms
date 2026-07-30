-- =============================================================================
-- CBT: theory (open-response) questions and human marking
-- =============================================================================
-- Theory questions live in the SAME banks as objective ones and reuse the same
-- level/topic targeting, so a subject bank can hold SS1 objective and SS2 theory
-- side by side. What differs is marking: there is no key to compare against, so a
-- HUMAN awards the marks (Golden Rule #8 — nothing here is auto-scored).
--
-- Answers get their OWN TABLE rather than a field inside the sitting's `answers`
-- JSON blob. Three reasons, each of which bites as cohorts grow:
--   1. autosave writes ONE row instead of rewriting every essay in the blob;
--   2. VERTICAL marking ("every answer to Q3") becomes an indexed query —
--      against a blob it would mean reading and parsing every sitting row;
--   3. a mark needs its own marker, timestamp and comment, with an audit trail.
-- =============================================================================

ALTER TABLE "cbt_question" ADD COLUMN "type"      TEXT    NOT NULL DEFAULT 'OBJECTIVE';
ALTER TABLE "cbt_question" ADD COLUMN "maxMarks"  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "cbt_question" ADD COLUMN "markGuide" TEXT;

CREATE TABLE "cbt_theory_answer" (
  "id"           UUID NOT NULL,
  "schoolId"     UUID NOT NULL,
  "examId"       UUID NOT NULL,
  "sittingId"    UUID NOT NULL,
  "questionId"   UUID NOT NULL,
  "studentId"    UUID NOT NULL,
  "text"         TEXT NOT NULL,
  "marksAwarded" INTEGER,
  "comment"      TEXT,
  "markedById"   UUID,
  "markedAt"     TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cbt_theory_answer_pkey" PRIMARY KEY ("id")
);

-- Autosave UPSERTS on this: one answer per (sitting, question).
CREATE UNIQUE INDEX "cbt_theory_answer_sittingId_questionId_key"
  ON "cbt_theory_answer"("sittingId", "questionId");
-- THE vertical-marking query: every answer to one question of one exam.
CREATE INDEX "cbt_theory_answer_examId_questionId_idx"
  ON "cbt_theory_answer"("examId", "questionId");
CREATE INDEX "cbt_theory_answer_schoolId_idx" ON "cbt_theory_answer"("schoolId");

ALTER TABLE "cbt_theory_answer"
  ADD CONSTRAINT "cbt_theory_answer_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cbt_theory_answer"
  ADD CONSTRAINT "cbt_theory_answer_sittingId_fkey"
  FOREIGN KEY ("sittingId") REFERENCES "cbt_sitting"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

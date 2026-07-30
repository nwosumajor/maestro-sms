-- =============================================================================
-- CBT: objective and theory as SEPARATE sections, and a term for grade recording
-- =============================================================================
-- A paper now declares its two sections independently:
--   objectiveCount — Section A, auto-marked, 1 mark each
--   theoryCount    — Section B, marked by hand, maxMarks each
-- theoryCount = 0 means an objective-only paper, whose result captures only the
-- objective score. With both set, the result is objective + theory.
--
-- `questionCount` is kept (sittings and DTOs already key on it) and is maintained
-- as the sum of the two sections. Existing papers are objective-only, so they
-- backfill objectiveCount = questionCount and theoryCount = 0 — no behaviour change.
--
-- `termId` is stamped at creation (mirroring Assessment.termId). Recording an
-- exam's scores into the gradesheet needs the term, and resolving "current term"
-- at record time would file a late-marked paper under the wrong term.
-- =============================================================================

ALTER TABLE "cbt_exam" ADD COLUMN "objectiveCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "cbt_exam" ADD COLUMN "theoryCount"    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "cbt_exam" ADD COLUMN "termId"         UUID;

-- Every existing paper is objective-only.
UPDATE "cbt_exam" SET "objectiveCount" = "questionCount" WHERE "objectiveCount" = 0;

ALTER TABLE "cbt_exam"
  ADD CONSTRAINT "cbt_exam_termId_fkey"
  FOREIGN KEY ("termId") REFERENCES "term"("id") ON DELETE SET NULL ON UPDATE CASCADE;

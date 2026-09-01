-- Publishing a scholarship's results to every school on the platform.
--
-- A score is a fact about a child's exam. It becomes public only when the
-- platform owner has reviewed the marking and decided to publish, so this is
-- NULL until then and the ranked table is invisible outside the operator
-- console. What is published is SCHOOL, POSITION and SCORE — never the pupil's
-- name, which is the owner's explicit decision and keeps a minor unnamed in a
-- cross-school table.
ALTER TABLE "scholarship_program"
  ADD COLUMN IF NOT EXISTS "resultsPublishedAt" TIMESTAMP(3);

-- The public read asks "which programmes have published results", newest first,
-- across every tenant. Partial, because most programmes have not published.
CREATE INDEX IF NOT EXISTS "scholarship_program_resultsPublishedAt_idx"
  ON "scholarship_program" ("resultsPublishedAt" DESC)
  WHERE "resultsPublishedAt" IS NOT NULL;

-- And the table itself: the scored candidates of one programme, ranked.
-- `(programId, status)` already exists; this adds the ordering column so the
-- ranked read is an index scan rather than a sort over every applicant the
-- programme ever had — the O(lifetime) shape this repo keeps finding.
CREATE INDEX IF NOT EXISTS "scholarship_application_programId_examScorePct_idx"
  ON "scholarship_application" ("programId", "examScorePct" DESC)
  WHERE "examScorePct" IS NOT NULL;

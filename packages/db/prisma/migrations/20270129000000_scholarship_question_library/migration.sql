-- A question written ONCE and reused across programmes.
--
-- A programme's paper lives inline on the programme (`examQuestions` JSON), and
-- that is right: a paper that has been sat must never change under the
-- candidates who sat it. The cost was that nothing survived the programme — a
-- question written for last year's exam had to be typed again this year, and a
-- correction to it reached only the one paper it was typed into.
--
-- So this is a LIBRARY that papers are assembled FROM, never a set of
-- references a paper points AT. Copying is the whole semantics: an edit here
-- changes what future papers are built from and touches no paper already built.
CREATE TABLE IF NOT EXISTS "scholarship_question" (
  "id"          UUID PRIMARY KEY,
  "subject"     TEXT NOT NULL,
  "text"        TEXT NOT NULL,
  "options"     TEXT[] NOT NULL,
  "answerIndex" INTEGER NOT NULL,
  -- An owner's own note — never printed on a paper and never sent anywhere.
  "note"        TEXT,
  "createdById" UUID NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);

-- The library grows with the platform's whole history and is browsed by subject
-- and by search. Without this, listing it is a seq scan that gets slower every
-- year — the O(lifetime) shape this repo has already measured three times.
CREATE INDEX IF NOT EXISTS "scholarship_question_subject_createdAt_idx"
  ON "scholarship_question" ("subject", "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "scholarship_question_createdAt_id_idx"
  ON "scholarship_question" ("createdAt" DESC, "id" DESC);

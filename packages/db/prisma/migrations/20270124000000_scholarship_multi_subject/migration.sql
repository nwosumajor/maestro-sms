-- A scholarship examined in MORE THAN ONE SUBJECT.
--
-- The subjects are derived from the questions (each question may name one), so
-- a paper can never exist with nothing on it and a subject can never be
-- silently dropped — there is no second list to fall out of step. This column
-- only STAGGERS the papers: `{ "Mathematics": { "examAt": ..., "durationMin": ... } }`.
-- A subject with no entry uses the programme's own examAt/examDurationMin,
-- which is exactly the single-paper behaviour this generalises.
ALTER TABLE "scholarship_program"
  ADD COLUMN IF NOT EXISTS "examSchedule" JSONB;

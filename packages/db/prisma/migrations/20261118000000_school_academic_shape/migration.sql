-- =============================================================================
-- school academic shape — calendar template + grade weighting
-- =============================================================================
-- Three terms and a 60/20/10/10 weighting are one country's convention. Both were
-- constants; a school running semesters, or weighting coursework differently, had
-- no way to say so.
--
-- Nullable with no backfill: null means the platform's default, so every school
-- already live keeps exactly the shape it has now.
-- =============================================================================

ALTER TABLE "school" ADD COLUMN IF NOT EXISTS "calendarTemplate" TEXT;
ALTER TABLE "school" ADD COLUMN IF NOT EXISTS "gradingPolicy"    JSONB;

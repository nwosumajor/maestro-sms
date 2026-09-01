-- A cap on how many candidates ONE school may have sitting a programme.
--
-- Driven by a 5,000-applicant exercise across three tenants: the largest school
-- held 2,500 of the 5,000 pupils and won ALL SIX podium places across both
-- categories, while the smallest ended with no exam created at all because no
-- candidate of theirs was qualified. A platform-funded scholarship that only
-- ever reaches the biggest school is not a growth lever for the platform.
--
-- NULLABLE, and null means NO CAP: every programme authored before now behaves
-- exactly as it did. A cap is a decision the platform owner takes per
-- programme, not a default this migration invents for them.
ALTER TABLE "scholarship_program"
  ADD COLUMN IF NOT EXISTS "maxCandidatesPerSchool" INTEGER;

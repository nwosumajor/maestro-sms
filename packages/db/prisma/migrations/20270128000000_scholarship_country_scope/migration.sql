-- Which countries a scholarship is open to.
--
-- A programme was global, on a platform whose catalogue holds 37 countries with
-- different currencies, academic calendars (THREE_TERM / TWO_SEMESTER /
-- FOUR_QUARTER, September or January year starts), curricula and compliance
-- regimes. One exam instant lands mid-term in one country and mid-holiday in
-- another, and the published table then ranks those schools against each other
-- on one paper.
--
-- A LIST, not a single country, and that is the point: the owner runs "Nigeria",
-- or "West Africa", or the whole platform, per programme. Fixing the granularity
-- in the schema would be the platform deciding a commercial question — and the
-- cost being balanced is real, since 37 countries x 3 positions from one budget
-- is a much smaller prize each.
--
-- NULL (and empty) means EVERY country: every programme authored before this
-- behaves exactly as it did.
ALTER TABLE "scholarship_program"
  ADD COLUMN IF NOT EXISTS "countries" TEXT[];

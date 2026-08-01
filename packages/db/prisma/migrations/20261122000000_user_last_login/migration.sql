-- Nothing recorded a successful sign-in anywhere: no audit action, no column. So
-- "this platform manager still holds lent duties but has not signed in since
-- March" could not be answered, which is the first question anyone reviewing
-- staff access asks.
--
-- Nullable with no backfill: NULL honestly means "not since this shipped", which
-- is different from — and must not be confused with — "never signed in". The
-- console renders those two distinctly.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);

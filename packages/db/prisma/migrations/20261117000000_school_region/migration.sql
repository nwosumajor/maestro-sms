-- =============================================================================
-- school region — country, timezone, locale, currency, compliance regime
-- =============================================================================
-- All NULLABLE with no backfill, deliberately: a null means "the platform's home
-- country", so every school already live keeps exactly the behaviour it has now.
-- Nothing is rewritten, and nobody's dates move underneath them.
--
-- The timezone column is the one that matters. Until now the server decided what
-- "today" was in UTC, so a register taken on Monday morning in Singapore was filed
-- against Sunday, and one taken on Monday evening in Toronto against Tuesday.
--
-- Guarded so re-running is a no-op: a failed migration blocks every later one and
-- takes the API down on boot (PR #21).
-- =============================================================================

ALTER TABLE "school" ADD COLUMN IF NOT EXISTS "country"          TEXT;
ALTER TABLE "school" ADD COLUMN IF NOT EXISTS "timezone"         TEXT;
ALTER TABLE "school" ADD COLUMN IF NOT EXISTS "locale"           TEXT;
ALTER TABLE "school" ADD COLUMN IF NOT EXISTS "currency"         TEXT;
ALTER TABLE "school" ADD COLUMN IF NOT EXISTS "complianceRegime" TEXT;
ALTER TABLE "school" ADD COLUMN IF NOT EXISTS "dpoName"          TEXT;
ALTER TABLE "school" ADD COLUMN IF NOT EXISTS "dpoEmail"         TEXT;

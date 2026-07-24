-- Calendar recurrence: ONE row describes a series; occurrences are expanded in
-- memory for the requested window (see @sms/types/recurrence.ts), so a weekly
-- assembly costs one row instead of forty.
ALTER TABLE "school_event" ADD COLUMN IF NOT EXISTS "recurrence" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "school_event" ADD COLUMN IF NOT EXISTS "recurrenceDays" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "school_event" ADD COLUMN IF NOT EXISTS "recurrenceUntil" TIMESTAMP(3);

-- The full-text GIN indexes deliberately live in prisma/rls/91_fulltext_indexes.sql,
-- NOT here: that directory is applied to db-push environments (CI/test) as well as
-- migrate-deploy ones, so every environment gets the same indexes.

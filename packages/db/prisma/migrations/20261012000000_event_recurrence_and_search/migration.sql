-- Calendar recurrence: ONE row describes a series; occurrences are expanded in
-- memory for the requested window (see @sms/types/recurrence.ts), so a weekly
-- assembly costs one row instead of forty.
ALTER TABLE "school_event" ADD COLUMN IF NOT EXISTS "recurrence" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "school_event" ADD COLUMN IF NOT EXISTS "recurrenceDays" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "school_event" ADD COLUMN IF NOT EXISTS "recurrenceUntil" TIMESTAMP(3);

-- Full-text search over discussion posts and messages.
-- Without these GIN indexes a search is a sequential scan over every row in the
-- tenant — exactly the kind of query that degrades as a school accumulates
-- history. `to_tsvector('english', body)` is IMMUTABLE, so it can be indexed
-- directly and the planner matches the identical expression used by the query.
-- NOTE: these live only in the migration (Postgres-specific, not expressible in
-- the Prisma schema). A `db push` environment (CI/test) still returns correct
-- results, just unindexed — which is fine at test data sizes.
CREATE INDEX IF NOT EXISTS "discussion_post_body_fts"
  ON "discussion_post" USING GIN (to_tsvector('english', "body"));
CREATE INDEX IF NOT EXISTS "message_body_fts"
  ON "message" USING GIN (to_tsvector('english', "body"));

-- Search is always tenant-scoped first; these keep the scoping cheap.
CREATE INDEX IF NOT EXISTS "discussion_post_school_created_idx"
  ON "discussion_post" ("schoolId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "message_school_created_idx"
  ON "message" ("schoolId", "createdAt" DESC);

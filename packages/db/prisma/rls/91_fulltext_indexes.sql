-- =============================================================================
-- Full-text search indexes (discussion posts + messages)
-- =============================================================================
-- These are EXPRESSION indexes on to_tsvector(...), which the Prisma schema
-- language cannot express — the same reason the partial unique indexes live in
-- 34_academic_rls.sql. They belong here rather than in a migration because this
-- directory is applied to EVERY environment:
--   * CI / test  -> `pnpm --filter @sms/db rls` (right after `prisma db push`)
--   * compose / cloud -> docker-entrypoint's apply_rls (after `migrate deploy`)
-- Keeping them migration-only left db-push environments running the searches as
-- sequential scans, i.e. schema drift and an unexercised indexed path.
--
-- Without these, a search is a sequential scan over every row in the tenant —
-- precisely the query shape that degrades as a school accumulates history.
-- `to_tsvector('english', body)` is IMMUTABLE, so it can be indexed directly and
-- the planner matches the identical expression used by the query.
--
-- NOTE: this file declares no POLICIES, so the entrypoint's pg_policies sentinel
-- never matches and it re-runs on every boot. That is deliberate and harmless —
-- every statement is IF NOT EXISTS, so a re-run is a catalog lookup.
-- =============================================================================

CREATE INDEX IF NOT EXISTS "discussion_post_body_fts"
  ON "discussion_post" USING GIN (to_tsvector('english', "body"));
CREATE INDEX IF NOT EXISTS "message_body_fts"
  ON "message" USING GIN (to_tsvector('english', "body"));

-- Search is always tenant-scoped and ordered newest-first; these keep that half
-- of the plan cheap too.
CREATE INDEX IF NOT EXISTS "discussion_post_school_created_idx"
  ON "discussion_post" ("schoolId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "message_school_created_idx"
  ON "message" ("schoolId", "createdAt" DESC);

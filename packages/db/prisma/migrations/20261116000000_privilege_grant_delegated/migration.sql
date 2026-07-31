-- =============================================================================
-- privilege_grant.delegated — a senior HANDS OVER a duty, rather than the holder
-- asking for it
-- =============================================================================
-- No new table: this is the same grant, reached from the other direction, so it
-- inherits the existing RLS policies, the guard's hasActiveGrant lookup, and the
-- NON_ELEVATABLE denylist that keeps maker-checker authorities out of it.
--
-- Guarded so re-running is a no-op: a failed migration blocks every later one and
-- takes the API down on boot (PR #21).
-- =============================================================================

ALTER TABLE "privilege_grant"
  ADD COLUMN IF NOT EXISTS "delegated" BOOLEAN NOT NULL DEFAULT false;

-- =============================================================================
-- Long-horizon index review: two daily jobs that were scanning whole tables
-- =============================================================================
-- Found by loading realistic volume and running EXPLAIN ANALYZE, not by reading.
--
-- 1. integrity_signal — the NDPR retention purge deletes by
--    (schoolId, createdAt < cutoff) EVERY NIGHT. There was no index for that
--    predicate, so it was a Parallel Seq Scan (measured: 46ms at 300k rows, and it
--    grows linearly). This table was low-volume before; CBT exam integrity now
--    writes a row per focus-loss per candidate per exam, which makes it the
--    fastest-growing table in the system — so the nightly purge must not scan it.
--
-- 2. student_profile — the profile-completion nudge sweep runs across ALL tenants
--    on its scheduled path, so it has NO schoolId to lead with and could not use
--    (schoolId, profileStatus). Measured: Seq Scan, 10ms at 40k profiles.
--    (profileStatus, lastNudgedAt) matches the sweep's predicate exactly.
--
-- IF NOT EXISTS throughout: an index-only migration must be re-runnable, per the
-- lesson from 20261031 (a plain CREATE INDEX aborted and then blocked every
-- migration queued behind it, taking the API down on boot).
-- =============================================================================

CREATE INDEX IF NOT EXISTS "integrity_signal_schoolId_createdAt_idx"
  ON "integrity_signal"("schoolId", "createdAt");

CREATE INDEX IF NOT EXISTS "student_profile_profileStatus_lastNudgedAt_idx"
  ON "student_profile"("profileStatus", "lastNudgedAt");

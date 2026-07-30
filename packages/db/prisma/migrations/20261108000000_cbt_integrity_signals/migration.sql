-- =============================================================================
-- CBT exam integrity: focus-loss / paste signals on a sitting
-- =============================================================================
-- The Assessment Integrity module already models exactly what a CBT exam needs —
-- typed signals (FOCUS_LOSS, PASTE, …) with severity, confidence and evidence —
-- but `submissionId` bound it to LMS submissions, so CBT could not use it at all.
--
-- Rather than a parallel table, a signal may now hang off EITHER a submission or a
-- CBT sitting, with a CHECK that exactly one is set. CBT telemetry therefore
-- inherits, unchanged:
--   * the NDPR retention purge (minors' telemetry, per-school window),
--   * RLS + the cross-tenant test,
--   * consent gating,
--   * the existing review surface.
--
-- Golden Rule #8 still governs what these MEAN: they are signals for a human to
-- review, never a verdict, penalty or automated consequence.
-- =============================================================================

ALTER TABLE "integrity_signal" ALTER COLUMN "submissionId" DROP NOT NULL;
ALTER TABLE "integrity_signal" ADD COLUMN "sittingId" UUID;

ALTER TABLE "integrity_signal"
  ADD CONSTRAINT "integrity_signal_sittingId_fkey"
  FOREIGN KEY ("sittingId") REFERENCES "cbt_sitting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "integrity_signal_sittingId_idx" ON "integrity_signal"("sittingId");

-- Exactly ONE owner. Without this, a signal could dangle with neither (orphaned
-- telemetry that no review surface would ever show) or both (ambiguous ownership).
ALTER TABLE "integrity_signal"
  ADD CONSTRAINT "integrity_signal_one_owner"
  CHECK (("submissionId" IS NOT NULL AND "sittingId" IS NULL)
      OR ("submissionId" IS NULL AND "sittingId" IS NOT NULL));

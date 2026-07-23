-- Per-student end-of-session outcomes on a promotion batch.
-- Nullable: existing batches keep their "promote everyone in studentIds" meaning.
ALTER TABLE "promotion_batch" ADD COLUMN IF NOT EXISTS "decisions" JSONB;

-- Did the background jobs actually run?
--
-- Thirteen jobs run on timers, including every one that moves money: dunning,
-- payment reconciliation, mobile-money recovery, late fees. Nothing recorded
-- that any of them had run — the only trace was a log line needing shell access
-- to read and gone on rotation.
--
-- A scheduler that silently stops does not error. Dunning stops charging,
-- reconciliation stops recovering lost payments, and the first sign is a
-- customer complaint months later.
CREATE TABLE IF NOT EXISTS "job_run" (
    "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
    "job"        TEXT         NOT NULL,
    "trigger"    TEXT         NOT NULL DEFAULT 'SCHEDULE',
    "startedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "ok"         BOOLEAN,
    "summary"    JSONB,
    "error"      TEXT,
    CONSTRAINT "job_run_pkey" PRIMARY KEY ("id")
);

-- "when did this job last run?" is the only question asked of this table.
CREATE INDEX IF NOT EXISTS "job_run_job_startedAt_idx" ON "job_run" ("job", "startedAt");

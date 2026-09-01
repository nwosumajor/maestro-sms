-- A scholarship prize gives the WINNER'S SCHOOL free ENTERPRISE for a period.
--
-- Held as a time-boxed uplift beside the purchased plan, never written over it:
-- `plan` is what the school bought and what renewal is priced from, so
-- overwriting it would bill a STANDARD school at ENTERPRISE seats and leave
-- them on ENTERPRISE for ever. `effectivePlan` resolves the better of the two
-- while `grantedUntil` is in the future, so the grant expires by DATE — no
-- sweep to run, nothing to repair, the same shape delinquency already uses.
ALTER TABLE "school_subscription"
  ADD COLUMN IF NOT EXISTS "grantedPlan" TEXT,
  ADD COLUMN IF NOT EXISTS "grantedUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "grantedReason" TEXT,
  -- When the school was last warned the grant is ending, so a nightly sweep
  -- reminds once rather than every night.
  ADD COLUMN IF NOT EXISTS "grantExpiryNoticeAt" TIMESTAMP(3);

-- The sweep asks "which grants end soon and have not been warned about", across
-- every tenant. Partial, because a granted subscription is a rare row.
CREATE INDEX IF NOT EXISTS "school_subscription_grantedUntil_idx"
  ON "school_subscription" ("grantedUntil")
  WHERE "grantedUntil" IS NOT NULL;

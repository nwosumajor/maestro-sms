-- =============================================================================
-- Ledger-replay bootstrap, part 3: restore the multi-currency shape
-- =============================================================================
-- Third and final piece of the pair described in
-- 20260713010500_plan_price_replay_bootstrap. Read that file first.
--
-- WHY THIS IS NEEDED, and why leaving it out would be worse than the original bug:
-- on a fresh replay the earlier two migrations create a placeholder plan_price, let
-- 20260713020000_multi_currency_billing ALTER it, then DROP it so the real
-- 20260726000000_plan_pricing can create it cleanly. That last CREATE writes the
-- ORIGINAL single-currency shape — so the ALTERs from 20260713020000 are discarded
-- and a fresh database ends up with:
--
--     columns: plan, perSeatMonthlyMinor, updatedAt        PRIMARY KEY (plan)
--
-- while every already-migrated database has:
--
--     columns: plan, perSeatMonthlyMinor, updatedAt, currency
--                                                    PRIMARY KEY (plan, currency)
--
-- `migrate deploy` would report complete success while producing a schema that
-- differs from production — a silent divergence, which is strictly more dangerous
-- than the loud 42P01 it replaced. This migration re-applies those two changes
-- idempotently so BOTH paths converge on the identical shape.
--
-- On an already-migrated database both checks are false and this is a no-op.
-- =============================================================================

-- Safe on every path: no-op when the column is already there.
ALTER TABLE "plan_price" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'NGN';

DO $$
BEGIN
  -- Repivot the primary key to (plan, currency) — one row per tier per currency —
  -- but ONLY while it is still the single-column original. Keyed on the column
  -- COUNT rather than a name match so it cannot misfire on an already-composite key.
  IF (
    SELECT array_length(conkey, 1)
    FROM pg_constraint
    WHERE conname = 'plan_price_pkey' AND conrelid = 'public.plan_price'::regclass
  ) = 1 THEN
    ALTER TABLE "plan_price" DROP CONSTRAINT "plan_price_pkey";
    ALTER TABLE "plan_price" ADD CONSTRAINT "plan_price_pkey" PRIMARY KEY ("plan", "currency");
    RAISE NOTICE 'restored the plan_price (plan, currency) primary key for a fresh replay';
  END IF;
END $$;

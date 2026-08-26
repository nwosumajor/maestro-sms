-- =============================================================================
-- The take-rate cap is a NAIRA figure, applied to every currency
-- =============================================================================
-- `platform_fee_config` is a SINGLETON keyed id='fees', carrying `flatMinor` and
-- `capMinor` in minor units with no currency at all. The take-rate rides the
-- Paystack split, and Paystack settles NGN, GHS, ZAR, KES and USD — so the same
-- kobo figures were applied to every one of them.
--
-- Measured against the live config (150bp capped at 200,000 = NGN 2,000):
--
--   NGN 150,000 invoice -> parent pays NGN 2,000    cap binds, as intended
--   GHS   5,000 invoice -> parent pays GHS    75    "cap" is GHS 2,000 — never binds
--   KES  75,000 invoice -> parent pays KES 1,125    "cap" is KES 2,000 — never binds
--   ZAR  15,000 invoice -> parent pays ZAR   225    "cap" is ZAR 2,000 — never binds
--
-- The cap is the only thing bounding what a parent pays in convenience fees, and
-- the fee is borne by the PARENT by default. In every non-naira currency it sits
-- 12x to 100x above the intended ceiling, so it is effectively disabled and the
-- full 150bp is charged uncapped.
--
-- Keyed per currency now, exactly like `plan_price` and `module_addon_price`,
-- both of which are `(x, currency)`. A currency with no row falls to the ZERO
-- default the service header already promises for a missing row — because this
-- is a CHARGE, and this repo's rule is that an unset charge goes to zero rather
-- than guessing, since a charge that guesses bills a family.
-- =============================================================================

ALTER TABLE "platform_fee_config"
  ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'NGN';

-- The existing singleton IS the naira config: it was authored in kobo and its
-- own validation messages say so. Backfilling it as NGN preserves every live
-- Nigerian school's fee exactly, and opens the other currencies as unset.
ALTER TABLE "platform_fee_config" DROP CONSTRAINT IF EXISTS "platform_fee_config_pkey";
ALTER TABLE "platform_fee_config"
  ADD CONSTRAINT "platform_fee_config_pkey" PRIMARY KEY ("id", "currency");

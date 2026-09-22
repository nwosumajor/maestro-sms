-- Subscription pricing moves from a per-seat MONTHLY atom to a per-seat SESSION
-- anchor. The term price is no longer stored at all: it is derived from the
-- session price and the SCHOOL'S OWN number of terms, so a two-semester school
-- divides by 2 and a four-quarter school by 4, while the session costs the same
-- everywhere.
--
-- The backfill reproduces TODAY'S ANNUAL CHARGE EXACTLY:
--   old YEAR price = monthly x 9 billed months x 0.85 commitment discount
--                  = monthly x 7.65
-- so no school on an annual cycle sees its renewal move by a single kobo.
--
-- Term payers DO move, deliberately: the old 5% term discount is gone because
-- the term is now the list price, so a term renewal rises by 1/0.95 - 1 = 5.26%.
--
-- The old column is kept, made NULLABLE, and dropped by a FOLLOW-UP migration
-- once this release has settled — so a rollback in between still has its data.

ALTER TABLE "plan_price" ADD COLUMN IF NOT EXISTS "perSeatSessionMinor" INTEGER;
UPDATE "plan_price"
   SET "perSeatSessionMinor" = ROUND("perSeatMonthlyMinor" * 7.65)
 WHERE "perSeatSessionMinor" IS NULL;
ALTER TABLE "plan_price" ALTER COLUMN "perSeatSessionMinor" SET NOT NULL;
ALTER TABLE "plan_price" ALTER COLUMN "perSeatMonthlyMinor" DROP NOT NULL;

ALTER TABLE "module_addon_price" ADD COLUMN IF NOT EXISTS "perSeatSessionMinor" INTEGER;
UPDATE "module_addon_price"
   SET "perSeatSessionMinor" = ROUND("perSeatMonthlyMinor" * 7.65)
 WHERE "perSeatSessionMinor" IS NULL;
ALTER TABLE "module_addon_price" ALTER COLUMN "perSeatSessionMinor" SET NOT NULL;
ALTER TABLE "module_addon_price" ALTER COLUMN "perSeatMonthlyMinor" DROP NOT NULL;

-- Cycles: MONTH is no longer sold and YEAR is renamed SESSION, which is what a
-- school calls it. Existing rows are migrated rather than left naming a cycle
-- the code no longer knows: a MONTH subscriber becomes a TERM subscriber at
-- their next renewal (the shortest thing still sold), and YEAR becomes SESSION
-- with no change in meaning, price or period length.
UPDATE "school_subscription" SET "billingCycle" = 'SESSION' WHERE "billingCycle" = 'YEAR';
UPDATE "school_subscription" SET "billingCycle" = 'TERM'    WHERE "billingCycle" = 'MONTH';
UPDATE "platform_subscription_payment" SET "billingCycle" = 'SESSION' WHERE "billingCycle" = 'YEAR';
UPDATE "platform_subscription_payment" SET "billingCycle" = 'TERM'    WHERE "billingCycle" = 'MONTH';

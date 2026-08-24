-- Operator-set pricing for single modules bought as add-ons.
--
-- Mirrors `plan_price` exactly, including its posture: GLOBAL (no schoolId, no
-- tenant data), readable by the least-privilege app role so quotes and checkout
-- can price a school's add-ons, and writable only through the privileged client
-- behind the operator's step-up-gated PUT.
--
-- A missing row is not zero: `MODULE_ADDON_PRICING` in @sms/types is the
-- fallback, the same way `PLAN_PRICING` backs the tier table. An unpriced module
-- must quote the code default rather than become free.
CREATE TABLE "module_addon_price" (
  "module"              TEXT NOT NULL,
  "currency"            TEXT NOT NULL DEFAULT 'NGN',
  "perSeatMonthlyMinor" INTEGER NOT NULL,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "module_addon_price_pkey" PRIMARY KEY ("module", "currency")
);

-- Which module an ADDON payment bought. Null for every other kind. A column
-- rather than free-text metadata, because the webhook reads this row to decide
-- what to switch on, and a charge whose effect is inferred from a string is a
-- charge nobody can audit afterwards.
ALTER TABLE "platform_subscription_payment" ADD COLUMN "addonModule" TEXT;

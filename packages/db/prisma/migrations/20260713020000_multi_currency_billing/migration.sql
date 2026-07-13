-- Dual-currency platform billing: NGN (Paystack) + USD (Stripe).
-- plan_price becomes one row per (tier, currency) — existing rows are NGN.
-- Payments/subscriptions record the charge currency; existing rows were NGN.
ALTER TABLE "plan_price" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'NGN';
ALTER TABLE "plan_price" DROP CONSTRAINT "plan_price_pkey";
ALTER TABLE "plan_price" ADD CONSTRAINT "plan_price_pkey" PRIMARY KEY ("plan", "currency");

ALTER TABLE "platform_subscription_payment" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'NGN';

ALTER TABLE "school_subscription" ADD COLUMN "currency" TEXT;

-- How many billing CYCLES a single subscription charge bought.
--
-- A school wanting several years of access previously had to pay repeatedly,
-- and concurrent charges against the same subscription raced each other for
-- currentPeriodEnd — four concurrent renewals advanced the period by two.
-- Buying N periods in one charge is one payment, one calculation, one row.
--
-- Existing rows default to 1, which is exactly what they meant.
ALTER TABLE "platform_subscription_payment"
  ADD COLUMN "billingPeriods" INTEGER NOT NULL DEFAULT 1;

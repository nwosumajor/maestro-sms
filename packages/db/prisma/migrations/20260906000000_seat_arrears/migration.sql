-- Metered seat arrears: unbilled seat-day usage accrued daily by the dunning
-- sweep, itemized into top-up/renewal charges and decremented on settlement.

ALTER TABLE "school_subscription" ADD COLUMN "seatArrearsMinor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "school_subscription" ADD COLUMN "arrearsAccruedAt" TIMESTAMP(3);
ALTER TABLE "platform_subscription_payment" ADD COLUMN "arrearsMinor" INTEGER NOT NULL DEFAULT 0;

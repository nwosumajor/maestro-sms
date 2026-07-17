-- Upgrade proration + seat true-up: each platform payment now says HOW it
-- applies (RENEWAL extends, UPGRADE restarts from now, TRUEUP updates seats only).

ALTER TABLE "platform_subscription_payment" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'RENEWAL';

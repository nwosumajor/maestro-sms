-- Saved-card auto-renew: reusable Paystack authorization (field-encrypted),
-- card display hint, and the opt-in flag on the subscription row.

ALTER TABLE "school_subscription" ADD COLUMN "paystackAuthorizationEnc" TEXT;
ALTER TABLE "school_subscription" ADD COLUMN "cardLast4" TEXT;
ALTER TABLE "school_subscription" ADD COLUMN "autoRenew" BOOLEAN NOT NULL DEFAULT false;

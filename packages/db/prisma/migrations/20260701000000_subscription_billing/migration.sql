-- Platform billing engine: self-serve, per-seat subscription payments.
-- (1) Extend school_subscription with billing posture (status / cycle / period /
--     seats / price). The PURCHASED `plan` is never overwritten by delinquency;
--     the app computes the effective plan from status + currentPeriodEnd.
-- (2) Add platform_subscription_payment — an APPEND-ONLY ledger of school->platform
--     payments (orthogonal to parent->school Fees). Tenant-scoped (non-null
--     schoolId); RLS in 24_subscription_billing_rls.sql (applied separately). A
--     PENDING row is created at checkout and flipped to PAID by the verified
--     Paystack webhook, which extends school_subscription.currentPeriodEnd.

ALTER TABLE "school_subscription"
    ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN "billingCycle" TEXT NOT NULL DEFAULT 'TERM',
    ADD COLUMN "currentPeriodEnd" TIMESTAMP(3),
    ADD COLUMN "seats" INTEGER,
    ADD COLUMN "priceMinor" INTEGER,
    ADD COLUMN "paystackCustomerCode" TEXT;

CREATE TABLE "platform_subscription_payment" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "billingCycle" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "initiatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "platform_subscription_payment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_subscription_payment_reference_key" ON "platform_subscription_payment"("reference");
CREATE INDEX "platform_subscription_payment_schoolId_idx" ON "platform_subscription_payment"("schoolId");

ALTER TABLE "platform_subscription_payment" ADD CONSTRAINT "platform_subscription_payment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

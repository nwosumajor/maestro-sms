-- Gateway chargeback/dispute tracking (Paystack charge.dispute.* webhook events).
-- payment_dispute is a tenant-scoped financial record: created/resolved by the
-- webhook, evidence-response tracked by finance staff, never hard-deleted
-- (RLS in rls/78 grants no DELETE).

CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'RESPONDED', 'WON', 'LOST');

CREATE TABLE "payment_dispute" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "gatewayDisputeId" TEXT NOT NULL,
    "transactionReference" TEXT NOT NULL,
    "paymentId" UUID,
    "invoiceId" UUID,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "category" TEXT,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "gatewayStatus" TEXT,
    "dueAt" TIMESTAMP(3),
    "responseNote" TEXT,
    "respondedById" UUID,
    "respondedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_dispute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_dispute_gatewayDisputeId_key" ON "payment_dispute"("gatewayDisputeId");
CREATE INDEX "payment_dispute_schoolId_idx" ON "payment_dispute"("schoolId");
CREATE INDEX "payment_dispute_schoolId_status_idx" ON "payment_dispute"("schoolId", "status");
CREATE INDEX "payment_dispute_schoolId_createdAt_idx" ON "payment_dispute"("schoolId", "createdAt");

ALTER TABLE "payment_dispute"
  ADD CONSTRAINT "payment_dispute_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- mobile_money_intent — what WE asked for, so an unsigned callback cannot lie
-- =============================================================================
-- Paystack and Stripe SIGN their webhooks. M-Pesa's Daraja callback and MTN's
-- Collections callback do not: anyone who learns the URL can POST to it. So the
-- callback is a notification, never a source of amounts — we record what we asked
-- for here, and settle from our own figure.
--
-- `reference` is UNIQUE: it is the idempotency key, and mobile money retries
-- callbacks aggressively.
--
-- Guarded so re-running is a no-op: a failed migration blocks every later one and
-- takes the API down on boot (PR #21).
-- =============================================================================

CREATE TABLE IF NOT EXISTS "mobile_money_intent" (
    "id"            UUID NOT NULL,
    "schoolId"      UUID NOT NULL,
    "reference"     TEXT NOT NULL,
    "provider"      TEXT NOT NULL,
    "invoiceId"     UUID NOT NULL,
    "amountMinor"   INTEGER NOT NULL,
    "currency"      TEXT NOT NULL,
    "msisdn"        TEXT NOT NULL,
    "payerId"       UUID,
    "status"        TEXT NOT NULL DEFAULT 'PENDING',
    "providerRef"   TEXT,
    "failureReason" TEXT,
    "settledAt"     TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mobile_money_intent_pkey" PRIMARY KEY ("id")
);

-- THE idempotency key. A duplicate callback finds the same row.
CREATE UNIQUE INDEX IF NOT EXISTS "mobile_money_intent_reference_key" ON "mobile_money_intent"("reference");
CREATE INDEX IF NOT EXISTS "mobile_money_intent_schoolId_idx" ON "mobile_money_intent"("schoolId");
-- Serves the reconciliation sweep over still-PENDING intents.
CREATE INDEX IF NOT EXISTS "mobile_money_intent_schoolId_status_idx" ON "mobile_money_intent"("schoolId", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mobile_money_intent_schoolId_fkey') THEN
    ALTER TABLE "mobile_money_intent" ADD CONSTRAINT "mobile_money_intent_schoolId_fkey"
      FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mobile_money_intent_invoiceId_fkey') THEN
    ALTER TABLE "mobile_money_intent" ADD CONSTRAINT "mobile_money_intent_invoiceId_fkey"
      FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

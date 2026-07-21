-- Append-only log of every VERIFIED gateway webhook event (Paystack + Stripe).
-- schoolId nullable: recording precedes tenant resolution. Immutable — the app
-- role gets INSERT + tenant-scoped SELECT only (rls/79).

CREATE TABLE "gateway_event" (
    "id" UUID NOT NULL,
    "schoolId" UUID,
    "gateway" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "reference" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "gateway_event_gateway_eventType_idx" ON "gateway_event"("gateway", "eventType");
CREATE INDEX "gateway_event_reference_idx" ON "gateway_event"("reference");
CREATE INDEX "gateway_event_schoolId_idx" ON "gateway_event"("schoolId");

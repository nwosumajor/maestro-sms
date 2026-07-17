-- SMS/WhatsApp credit bundles: user phone for delivery targets, the WHATSAPP
-- channel, and the append-only per-school credit ledger (RLS in rls/73).

ALTER TABLE "user" ADD COLUMN "phone" TEXT;
ALTER TYPE "NotificationChannel" ADD VALUE IF NOT EXISTS 'WHATSAPP';

CREATE TABLE "message_credit_entry" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "deltaCredits" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "channel" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_credit_entry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "message_credit_entry_schoolId_idx" ON "message_credit_entry"("schoolId");
ALTER TABLE "message_credit_entry" ADD CONSTRAINT "message_credit_entry_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

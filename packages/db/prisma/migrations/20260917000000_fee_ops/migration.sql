-- Fee ops: automatic late-fee config on the school registry + maker-checker
-- invoice adjustments (discount/waiver history, never hard-deleted).

ALTER TABLE "school" ADD COLUMN "lateFeeFlatMinor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "school" ADD COLUMN "lateFeeGraceDays" INTEGER NOT NULL DEFAULT 7;

CREATE TABLE "invoice_adjustment" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requestedById" UUID NOT NULL,
    "approvedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_adjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "invoice_adjustment_schoolId_idx" ON "invoice_adjustment"("schoolId");
CREATE INDEX "invoice_adjustment_schoolId_invoiceId_idx" ON "invoice_adjustment"("schoolId", "invoiceId");
CREATE INDEX "invoice_adjustment_schoolId_status_idx" ON "invoice_adjustment"("schoolId", "status");

ALTER TABLE "invoice_adjustment"
  ADD CONSTRAINT "invoice_adjustment_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_adjustment"
  ADD CONSTRAINT "invoice_adjustment_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

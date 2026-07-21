-- Installment plans (tranche schedule on an issued invoice) + the append-only
-- student credit ledger (prepayments / overpayments moved to credit), and the
-- CREDIT payment kind that applies a balance to an invoice.

ALTER TYPE "PaymentKind" ADD VALUE IF NOT EXISTS 'CREDIT';

CREATE TABLE "invoice_installment" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_installment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invoice_installment_invoiceId_seq_key" ON "invoice_installment"("invoiceId", "seq");
CREATE INDEX "invoice_installment_schoolId_idx" ON "invoice_installment"("schoolId");
CREATE INDEX "invoice_installment_schoolId_invoiceId_idx" ON "invoice_installment"("schoolId", "invoiceId");

ALTER TABLE "invoice_installment"
  ADD CONSTRAINT "invoice_installment_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_installment"
  ADD CONSTRAINT "invoice_installment_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "student_credit_entry" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "deltaMinor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_credit_entry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "student_credit_entry_schoolId_studentId_idx" ON "student_credit_entry"("schoolId", "studentId");
CREATE INDEX "student_credit_entry_reference_idx" ON "student_credit_entry"("reference");

ALTER TABLE "student_credit_entry"
  ADD CONSTRAINT "student_credit_entry_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Paystack split settlement: parents' fee payments flow to the school's OWN
-- bank via a per-school subaccount. Full account numbers are never stored.
ALTER TABLE "school"
  ADD COLUMN "paystackSubaccountCode" TEXT,
  ADD COLUMN "settlementBankCode" TEXT,
  ADD COLUMN "settlementBankName" TEXT,
  ADD COLUMN "settlementAccountLast4" TEXT;

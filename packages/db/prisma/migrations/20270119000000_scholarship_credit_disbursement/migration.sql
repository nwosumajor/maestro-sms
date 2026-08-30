-- An award decided BEFORE the term's fees are raised had nowhere to go.
--
-- `disburseFeesCredit` returned `no_open_invoice` and nothing retried, so the
-- award stood and the money never moved: four AWARDED applications totalling
-- NGN 800,000 with nothing posted. Every OTHER path that moves money against a
-- pupil already handles this — the library, hostel and transport runs create an
-- invoice, and a dedicated-account transfer posts to the CREDIT LEDGER and
-- tells finance to apply it from the next invoice's page.
--
-- The scholarship now uses that same credit ledger, and this column is the link
-- back, mirroring `disbursementPaymentId` beside it. Nullable: an award posted
-- straight to an invoice has no credit entry, and vice versa.
ALTER TABLE "scholarship_application"
  ADD COLUMN IF NOT EXISTS "disbursementCreditEntryId" UUID;

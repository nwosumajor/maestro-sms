-- What money a scholarship is awarded in.
--
-- `AWARD_CURRENCY = "NGN"` was a CONSTANT, for a platform whose catalogue holds
-- 37 countries. `disburseFeesCredit` refuses a currency it cannot match — right,
-- because crediting 60,000 pesewas against a naira figure would clear a family's
-- fees while the books recorded a hundredth of it — so the whole prize simply
-- did not reach anyone outside the platform's home currency.
--
-- Measured on a 5,000-applicant exercise across three schools: THREE OF SIX
-- awards were refused, because one school bills in GHS. Every one of them stood
-- as AWARDED with nothing posted, waiting for somebody to enter it by hand.
--
-- NULLABLE, and null means the platform's home currency: every programme
-- authored before this behaves exactly as it did.
ALTER TABLE "scholarship_program"
  ADD COLUMN IF NOT EXISTS "awardCurrency" TEXT;

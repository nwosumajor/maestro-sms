-- THE PLATFORM'S FEE-COLLECTION REVENUE, WITHOUT READING EVERY PAYMENT EVER MADE.
--
-- `payment.platformFeeMinor` is the take-rate stamped on every settled online
-- payment. It was written by the settlement path and read by nothing, so the
-- operator revenue screen now totals it per currency -- a cross-tenant read on
-- the privileged client, over a table that grows with every fee any family pays
-- on the whole platform.
--
-- Measured on 404,517 payments spread over five years, as `postgres` (correct
-- here, and only here: this read runs on the PRIVILEGED client, which bypasses
-- RLS -- every other measurement in this repo must be taken as `major_user`
-- with the tenant GUC set):
--
--   30-day report, no index : Parallel Seq Scan, 5,002 of 404,517 rows, 60.0 ms
--   30-day report, this index: Bitmap Index Scan,                      12.7 ms
--
-- PARTIAL on both predicates. Only settled payments that actually carried a cut
-- are ever asked about -- three quarters of a busy fleet's payments are manual
-- or fee-free -- so the index stays a fraction of the table and costs writes
-- nothing on the rows it excludes.
--
-- The LIFETIME figure (no date range) still seq-scans, at 80 ms, and correctly
-- so: it wants most of the table and no index beats reading it. Recorded rather
-- than papered over, because that one grows with the platform's age.
CREATE INDEX "payment_platform_fee_idx"
  ON "payment" ("createdAt")
  WHERE "platformFeeMinor" > 0 AND status = 'POSTED';

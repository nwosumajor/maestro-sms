-- "Net paid per invoice" over a school's WHOLE history: POSTED payments, refunds
-- subtracting. The finance report's receivables, the group console's "owed now"
-- and the nightly ledger-integrity check all aggregate it, uncorrelated, over
-- every POSTED payment a school (or a group of schools) has ever taken.
--
-- Measured on a 30-campus group with ten years of history (420,000 invoices,
-- 407,423 payments), the group console's "owed now":
--   without this index   Seq Scan + HashAggregate, spilling 30 MB to disk   ~1,200 ms
--   with it              Index Only Scan + streaming GroupAggregate          ~  690 ms
-- (work_mem 64MB alone: ~1,050 ms; no parallelism: slower — the join, not the
-- aggregate, is then single-threaded.)
--
-- PARTIAL on POSTED, because PENDING_APPROVAL and REJECTED never count toward a
-- balance and every reader filters them out. INCLUDE carries the columns the
-- sum reads, so the payment heap is never visited. Write cost measured: 20,000
-- payment inserts 1,839 ms without vs 1,773 ms with — inside the noise, because
-- the FK checks dominate an insert.
--
-- Prisma cannot express a partial index or INCLUDE, so it lives here only;
-- schema/fees.prisma names it beside the Payment model so it is not read as
-- missing (the convention notifications.prisma and scholarship.prisma follow).
CREATE INDEX IF NOT EXISTS "payment_posted_invoice_net_idx"
  ON "payment" ("invoiceId")
  INCLUDE ("schoolId", "kind", "amountMinor")
  WHERE "status" = 'POSTED';

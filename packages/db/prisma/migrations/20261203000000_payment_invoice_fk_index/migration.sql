-- payment.invoiceId, and every other child of `invoice`, had no standalone
-- index — the same defect fixed for
-- notification_delivery.notificationId in 20261202000000.
--
-- Postgres indexes the PARENT side of a foreign key automatically (it is the
-- primary key) and never the CHILD side. FK enforcement runs
-- `WHERE "invoiceId" = $1` with NO schoolId, so the existing
-- (schoolId, invoiceId) composite cannot serve it: wrong leading column. Every
-- delete or key-update of an invoice therefore seq-scanned the whole payment
-- table, once per invoice row touched.
--
-- Measured against 182,702 payments:
--     FK check          Seq Scan, ~16-19 ms EACH
--     216,000 invoices  did not finish in 72 minutes
--     same, vs 4,502 payments   4m17s
--
-- Write cost of carrying the index, over 21,600 inserts (median of 3):
--     1,697 ms -> 1,766 ms      +4%
-- That is the trade being accepted. It is small in practice because payments
-- are written one at a time, not 21,600 at a time; the FK check it removes is
-- paid per invoice row on every delete.
--
-- CONCURRENTLY is not used: Prisma wraps each migration in a transaction and
-- CREATE INDEX CONCURRENTLY cannot run inside one. On a large existing payment
-- table, build it by hand outside the migration instead.
CREATE INDEX IF NOT EXISTS "payment_invoiceId_idx" ON "payment" ("invoiceId");

-- Indexing payment alone does NOT make an invoice delete fast: `invoice` has
-- five children and the check fires for EVERY one of them. Three others had the
-- same gap, so the delete would still have seq-scanned them and the fix would
-- have measured as no fix at all.
--
-- invoice_line_item is the one that matters most in production: it grows
-- one-to-many with invoices, so it ends up LARGER than payment. It reads as
-- harmless here only because the volume seeder creates invoices without line
-- items. invoice_installment was already indexed.
CREATE INDEX IF NOT EXISTS "invoice_line_item_invoiceId_idx"   ON "invoice_line_item" ("invoiceId");
CREATE INDEX IF NOT EXISTS "invoice_adjustment_invoiceId_idx"  ON "invoice_adjustment" ("invoiceId");
CREATE INDEX IF NOT EXISTS "mobile_money_intent_invoiceId_idx" ON "mobile_money_intent" ("invoiceId");

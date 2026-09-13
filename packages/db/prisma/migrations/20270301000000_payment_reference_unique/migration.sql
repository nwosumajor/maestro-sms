-- ONE GATEWAY CHARGE POSTS ONCE.
--
-- `InvoiceSettlementService` guarded with findFirst-then-create, which at READ
-- COMMITTED lets concurrent deliveries of the same webhook all read nothing and
-- all insert. Measured: six simultaneous deliveries of one signed Paystack
-- event, identical reference on all six, posted six payments against a
-- 5,000,000 invoice — 30,000,000 credited and the invoice marked PAID.
--
-- NULL references stay distinct under a Postgres unique index, so manual
-- payments that carry no gateway reference are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_invoiceId_reference_key"
  ON "payment" ("invoiceId", "reference");

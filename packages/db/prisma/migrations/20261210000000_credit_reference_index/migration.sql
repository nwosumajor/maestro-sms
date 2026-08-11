-- The idempotency lookup on every credit purchase and every recovery check.
--
-- applyPurchase asks "has this gateway reference already produced an entry?"
-- before crediting, and the reconciliation sweep asks it once per charge. With
-- no index that is a Parallel Seq Scan of the whole ledger: measured at 94ms
-- against 900,000 entries — a school sending 500 messages a day for five years
-- — on the path that decides whether a school's money becomes credits.
--
-- 94ms -> 0.087ms.
CREATE INDEX IF NOT EXISTS "message_credit_entry_reference_idx"
  ON "message_credit_entry" ("reference");

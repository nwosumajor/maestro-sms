-- A promo code's BUDGET has to count the checkouts already in flight, which
-- means a count on every promo checkout across every school.
--
-- PARTIAL, on the LIVE checkouts only. A pending intent is transient — the
-- dunning sweep's `expireStaleIntents` marks an abandoned one ABANDONED — so
-- the index holds a handful of rows however long the platform runs, while the
-- table itself grows with every renewal of every school for ever.
--
-- MEASURED at 600,000 payments, with a BOUND PARAMETER after five warm-up
-- executions so the plan under test is the GENERIC one a pooled application
-- gets (a literal would have reported this as already fast):
--
--     no index    Parallel Seq Scan   13,335 buffers   38.9 ms
--     this index  Index Only Scan          3 buffers    0.015 ms   (16 kB)
CREATE INDEX IF NOT EXISTS "platform_subscription_payment_promo_inflight_idx"
    ON "platform_subscription_payment" ("promoCode")
 WHERE status = 'PENDING' AND "promoCode" IS NOT NULL;

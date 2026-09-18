-- AN INDEX I ADDED BY REASONING, MEASURED, AND FOUND DEAD.
--
-- `20270321000000_invoice_last_reminded_at` shipped
-- "invoice_schoolId_status_lastRemindedAt_idx" with a comment explaining why it
-- was tenant-leading — and no measurement. This repo's own rule is that an
-- index nothing selects is write amplification, so it was measured as the app
-- role under RLS, with a bound parameter, on ten years of one school's billing
-- (18,014 invoices, 14,405 of them open).
--
-- It is never chosen. Not "rarely": never, for this query or any other.
-- With it present and nothing else to help, the reminder page still plans:
--
--   Limit -> Sort (top-N heapsort, 547kB)
--             -> Seq Scan on invoice (14,405 rows read, 3,609 discarded)
--   Execution Time: 26.9 ms
--
-- The reason is the shape of the predicate, and it is the durable part:
-- `status IN ('ISSUED','PARTIALLY_PAID')` is not an equality on ONE value, so a
-- btree keyed (schoolId, status, lastRemindedAt) cannot walk "lastRemindedAt"
-- in order — it would have to merge two status runs. The ordering column sits
-- BEHIND a non-equality predicate, and that makes it unreachable for ORDER BY.
-- The index is also a strict prefix-superset of invoice_schoolId_status_idx
-- (17,774 scans), which already serves every read that only filters, so there
-- is nothing left for it to win.
--
-- Moving the predicate into a PARTIAL index removes status from the key
-- entirely, and the ordering columns come to the front:
--
--   Limit -> Index Scan using invoice_reminder_rotation_idx
--   Execution Time: 2.5 ms, shared hit=2019, no sort
--
-- 26.9 ms -> 2.5 ms, and the sort disappears rather than getting cheaper. The
-- sweep reads 2,000 index entries instead of every open invoice the school has
-- ever raised, so the cost tracks the PAGE and not the school's lifetime.
--
-- The trailing "dueDate", id complete the sweep's own ORDER BY, so the walk
-- needs no re-sort within a lastRemindedAt group; NULLS FIRST matches the
-- rotation rule (never-chased before least-recently-chased).
DROP INDEX IF EXISTS "invoice_schoolId_status_lastRemindedAt_idx";

CREATE INDEX IF NOT EXISTS "invoice_reminder_rotation_idx"
  ON "invoice" ("schoolId", "lastRemindedAt" NULLS FIRST, "dueDate", id)
  WHERE status IN ('ISSUED', 'PARTIALLY_PAID');

-- Scale indexes for platform_feedback (high-volume feedback, e.g. 5000/day).
-- The owner's cross-tenant inbox and the per-user flood cap otherwise table-scan
-- once the append-only table grows into the millions.

-- Sender's own list (listMine) + per-user rate-limit count.
CREATE INDEX "platform_feedback_userId_createdAt_idx" ON "platform_feedback"("userId", "createdAt");

-- Owner cross-tenant keyset (ORDER BY createdAt DESC, id DESC — scanned backward).
CREATE INDEX "platform_feedback_createdAt_id_idx" ON "platform_feedback"("createdAt", "id");

-- Status-filtered inbox keyset + the grouped stats query.
CREATE INDEX "platform_feedback_status_createdAt_id_idx" ON "platform_feedback"("status", "createdAt", "id");

-- Drop the redundant (schoolId, createdAt) index: no query orders by school+time
-- (listMine filters by userId), so it only cost write throughput. IF EXISTS so
-- this is a no-op on a fresh db-push DB that never created it.
DROP INDEX IF EXISTS "platform_feedback_schoolId_createdAt_idx";

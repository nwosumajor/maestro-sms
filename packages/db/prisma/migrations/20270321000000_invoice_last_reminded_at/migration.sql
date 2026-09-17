-- WHY A SWEEP NEEDS A MARKER WHEN ITS PREDICATE NEVER CHANGES.
--
-- The overdue fee reminder pages the school's open invoices, capped, and writes
-- nothing back to them — an unpaid invoice stays overdue, so the SAME page
-- matched every week. Ordering oldest-first made that deterministic rather than
-- fixing it: measured on 2,100 overdue invoices against a cap of 2,000, two
-- full runs sent 2,000 reminders each about the identical 2,000 invoices, and
-- the 100 NEWEST arrears were never chased once. `backlog` reported 105 on both
-- runs, which reads as behind rather than stuck.
--
-- `lastRemindedAt` is what the sweep changes, so ordering by it (NULLS FIRST)
-- rotates: never-chased invoices go first, then the least-recently-chased. It
-- is also a fact the school wants anyway — when this family was last asked.
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "lastRemindedAt" TIMESTAMP(3);

-- Tenant-leading, because the sweep runs inside each school's own RLS
-- transaction and there is no cross-tenant read here to serve.
CREATE INDEX IF NOT EXISTS "invoice_schoolId_status_lastRemindedAt_idx"
  ON "invoice" ("schoolId", status, "lastRemindedAt");

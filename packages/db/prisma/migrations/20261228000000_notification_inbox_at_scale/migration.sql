-- The inbox in year ten, and three indexes that were never being used.
--
-- 1. THE INBOX'S OWN QUERY.
--
-- Every read of this table is "this person's, newest first, one page", and no
-- index carried "createdAt". Measured on the platform owner — recipient of every
-- operator alert, dunning digest, dispute warning and onboarding request — with
-- 500,000 notifications, as the APPLICATION role with RLS in force:
--
--   before   Parallel Seq Scan, 500,000 rows, 11,654 buffers, 63 ms  (for 100 rows)
--   after    Index Scan,                          18 buffers, 0.12 ms
--
-- The cost stops scaling with how long the account has existed and starts
-- scaling with the page size. It also bounds SEARCH, which filters ILIKE over
-- the rows this index narrows to: 0.9 ms for an ordinary inbox.
CREATE INDEX IF NOT EXISTS "notification_schoolId_recipientId_createdAt_idx"
  ON "notification" ("schoolId", "recipientId", "createdAt" DESC);

-- 2. THREE TRIGRAM INDEXES THAT CANNOT BE USED, AND THE REASON.
--
-- 20260925000000_search_trigram_indexes added GIN trigram indexes for global
-- search, stating that they make ILIKE index-accelerated. They do — for a role
-- that BYPASSES ROW-LEVEL SECURITY, which is how the plan was checked. The
-- application does not run as one.
--
-- `texticlike` (the function behind ILIKE) has proleakproof = false. Postgres
-- will not evaluate a non-leakproof operator BEFORE a row-security qual, since
-- doing so could reveal something about rows the caller may not see. So under
-- RLS the trigram index is unreachable and the query is a sequential scan. The
-- same query, same data, differs only by who asks:
--
--   as postgres (RLS bypassed)   Bitmap Index Scan on user_name_trgm_idx, 0.9 ms
--   as major_user (RLS in force) Seq Scan
--
-- Nothing that runs on the privileged, RLS-bypassing client searches these three
-- columns — the operator console's searches are all against `school` (name,
-- slug, ownerName, ownerPhone) and `user.email`. So all three carry storage and
-- write amplification on `user`, `class` and `invoice` and return nothing.
--
-- This is also why NO trigram index is added for the notification search above:
-- it would have been a fourth one, 33 MB against a 90 MB table, equally unused.
--
-- Bring them back if a privileged cross-tenant search over these columns is
-- built — that reader would use them.
DROP INDEX IF EXISTS "user_name_trgm_idx";
DROP INDEX IF EXISTS "class_name_trgm_idx";
DROP INDEX IF EXISTS "invoice_reference_trgm_idx";

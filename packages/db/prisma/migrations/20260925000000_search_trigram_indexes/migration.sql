-- Global search (GET /search?q=) matches with ILIKE '%term%'. A LEADING wildcard
-- cannot use a btree index, so those queries planned as SEQUENTIAL SCANS —
-- verified with EXPLAIN. Harmless on a small table, but `user` is shared across
-- every tenant, so the scan grows with the whole platform rather than with one
-- school. Trigram GIN indexes make ILIKE index-accelerated.
--
-- CONCURRENTLY is deliberately NOT used: Prisma wraps each migration in a
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one. These tables
-- are small enough at migration time that the brief lock is acceptable; on a
-- very large existing database, build them out-of-band instead.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "user_name_trgm_idx" ON "user" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "class_name_trgm_idx" ON "class" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "invoice_reference_trgm_idx" ON "invoice" USING gin ("reference" gin_trgm_ops);

-- The term sweep now excludes already-archived terms with an anti-join on
-- `termId`. The only index carrying that column is UNIQUE (schoolId, termId),
-- which is schoolId-leading and cannot serve a lookup by termId alone — proven
-- with EXPLAIN: `Seq Scan on school_archive`.
--
-- Harmless while the table is small and quietly quadratic once it is not: the
-- sweep runs nightly over every ended term in the fleet, and this table grows
-- for ever by design ("kept indefinitely" is what the archive is for).
CREATE INDEX "school_archive_termId_idx" ON "school_archive" ("termId");

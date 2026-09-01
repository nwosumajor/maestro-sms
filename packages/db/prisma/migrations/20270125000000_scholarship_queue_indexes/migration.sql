-- The platform owner's scholarship review queue is O(the platform's LIFETIME).
--
-- `listApplications` pages with ORDER BY "createdAt", id and counts the backlog
-- beside it, and nothing served either. Measured as the PRIVILEGED role — this
-- read runs on the privileged cross-tenant client, so postgres is the correct
-- role here, unlike a tenant read — on a realistic decade: 505,004 applications
-- of which 5,000 still await a decision.
--
-- EVERY SHAPE WAS MEASURED WITH A BOUND PARAMETER, five executions first so the
-- plan under test is the GENERIC one, which is what a pooled application gets.
-- That mattered: with a literal, Postgres picked the right index and the
-- filtered page read 0.5 ms; with a parameter it switched to the generic plan,
-- walked the whole ("createdAt", id) index oldest-first looking for rows that
-- are the NEWEST, and took 213 ms over 497,011 buffers.
--
--   unfiltered page      Parallel Seq Scan + sort  63.0 ms  ->  0.24 ms
--   ?status= page        Index Scan, 497,011 bufs 213.3 ms  ->  0.09 ms
--   ?programId= page     Index Scan, 497,071 bufs 153.8 ms  ->  0.09 ms
--   backlog count        Parallel Seq Scan         46.5 ms  ->  0.75 ms
--
-- Each of the three is chosen by the planner for a shape the other two cannot
-- serve; each was verified by DROPPING it and watching the plan collapse back.
-- A fourth — a partial index on the undecided statuses — was built, measured,
-- and NOT kept: (status, "createdAt", id) already serves that count at 0.75 ms,
-- and an index nothing selects is storage and write amplification on a table
-- that only grows.
CREATE INDEX IF NOT EXISTS "scholarship_application_createdAt_id_idx"
  ON "scholarship_application" ("createdAt", "id");

CREATE INDEX IF NOT EXISTS "scholarship_application_status_createdAt_id_idx"
  ON "scholarship_application" ("status", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "scholarship_application_programId_createdAt_id_idx"
  ON "scholarship_application" ("programId", "createdAt", "id");

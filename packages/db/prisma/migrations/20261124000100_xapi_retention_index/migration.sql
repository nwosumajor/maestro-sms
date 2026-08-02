-- The retention sweep now purges xapi_statement, filtering on (schoolId,
-- storedAt). The existing indexes are schoolId, (schoolId, classId) and
-- (schoolId, actorId) — none serves that filter, so the nightly sweep would walk
-- every statement a school has ever recorded to find the old ones, on the table
-- most likely to be the largest in the database.
CREATE INDEX IF NOT EXISTS "xapi_statement_schoolId_storedAt_idx"
  ON "xapi_statement" ("schoolId", "storedAt");

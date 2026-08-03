-- Term granularity for the archive, so a scheduled sweep can archive each term
-- exactly once.
--
-- The UNIQUE constraint is the idempotency, deliberately in the DATABASE rather
-- than in the job. A daily sweep that "remembers" what it already did is one
-- restart away from doing it twice, and a duplicate archive is not harmless: it
-- is a second file with the same name and a different checksum, which is exactly
-- the ambiguity an archive exists to prevent.
--
-- NULLs do not collide in a Postgres unique index, so manually-taken archives
-- (termId NULL) remain unlimited.
ALTER TABLE "school_archive" ADD COLUMN IF NOT EXISTS "termId" UUID;
CREATE UNIQUE INDEX IF NOT EXISTS "school_archive_schoolId_termId_key"
  ON "school_archive" ("schoolId", "termId");

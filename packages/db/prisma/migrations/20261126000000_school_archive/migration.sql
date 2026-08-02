-- A point-in-time archive of the school's whole institutional record for one
-- academic session: the artifact a principal produces so a question asked in ten
-- years can still be answered without restoring a database.
CREATE TABLE IF NOT EXISTS "school_archive" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "schoolId"      UUID NOT NULL,
  "sessionId"     UUID,
  "label"         TEXT NOT NULL,
  "storageKey"    TEXT NOT NULL UNIQUE,
  "checksum"      TEXT NOT NULL,
  "sizeBytes"     INTEGER NOT NULL,
  "sections"      JSONB NOT NULL,
  "containsHrPii" BOOLEAN NOT NULL DEFAULT true,
  "createdById"   UUID NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "school_archive_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "school_archive_schoolId_idx"           ON "school_archive" ("schoolId");
CREATE INDEX IF NOT EXISTS "school_archive_schoolId_createdAt_idx" ON "school_archive" ("schoolId", "createdAt");

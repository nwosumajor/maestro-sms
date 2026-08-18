-- =============================================================================
-- Supplied documents: what a school asks somebody for, and what came back
-- =============================================================================
-- Two tenant-scoped tables behind the admission and hire flows. Both carry a
-- non-null schoolId with an FK to `school` (RESTRICT), like every other
-- tenant-scoped table here — the FK is what stops a row outliving its school.
--
-- RLS is applied SEPARATELY (prisma/rls/109, /110), not from this migration:
-- Prisma's shadow database rejects the GRANT to major_user.
-- =============================================================================

CREATE TABLE "document_requirement" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "schoolId"    UUID         NOT NULL,
  "appliesTo"   TEXT         NOT NULL,
  "key"         TEXT         NOT NULL,
  "label"       TEXT         NOT NULL,
  "description" TEXT,
  "mandatory"   BOOLEAN      NOT NULL DEFAULT false,
  "needsExpiry" BOOLEAN      NOT NULL DEFAULT false,
  "sequence"    INTEGER      NOT NULL DEFAULT 0,
  "active"      BOOLEAN      NOT NULL DEFAULT true,
  "createdById" UUID         NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_requirement_pkey" PRIMARY KEY ("id")
);

-- One requirement per key per scope per school. The school may reword the
-- LABEL freely; the key is what code and the seed match on.
CREATE UNIQUE INDEX "document_requirement_schoolId_appliesTo_key_key"
  ON "document_requirement" ("schoolId", "appliesTo", "key");
CREATE INDEX "document_requirement_schoolId_idx" ON "document_requirement" ("schoolId");
CREATE INDEX "document_requirement_schoolId_appliesTo_active_idx"
  ON "document_requirement" ("schoolId", "appliesTo", "active");

ALTER TABLE "document_requirement"
  ADD CONSTRAINT "document_requirement_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "document_submission" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "schoolId"         UUID         NOT NULL,
  "subjectKind"      TEXT         NOT NULL,
  "subjectId"        UUID         NOT NULL,
  "requirementId"    UUID,
  "storageKey"       TEXT,
  "contentType"      TEXT,
  "sizeBytes"        INTEGER,
  "originalName"     TEXT,
  "status"           TEXT         NOT NULL DEFAULT 'PENDING',
  "uploadedByUserId" UUID,
  "uploadedAt"       TIMESTAMP(3),
  "verifiedById"     UUID,
  "verifiedAt"       TIMESTAMP(3),
  "rejectedReason"   TEXT,
  "expiresAt"        DATE,
  "documentId"       UUID,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_submission_pkey" PRIMARY KEY ("id")
);

-- One object, one row. Nullable because a WAIVED row records a decision that no
-- file will arrive, and a PENDING row has not been uploaded to yet; Postgres
-- treats NULLs as distinct, so neither collides.
CREATE UNIQUE INDEX "document_submission_storageKey_key"
  ON "document_submission" ("storageKey");
CREATE INDEX "document_submission_schoolId_idx" ON "document_submission" ("schoolId");
CREATE INDEX "document_submission_schoolId_subjectKind_subjectId_idx"
  ON "document_submission" ("schoolId", "subjectKind", "subjectId");
CREATE INDEX "document_submission_schoolId_status_idx"
  ON "document_submission" ("schoolId", "status");
-- The cross-tenant retention sweep reads by status and age; without this it is
-- a sequential scan over every submission the platform has ever taken.
CREATE INDEX "document_submission_status_createdAt_idx"
  ON "document_submission" ("status", "createdAt");

ALTER TABLE "document_submission"
  ADD CONSTRAINT "document_submission_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A requirement that has collected submissions cannot simply vanish — that is
-- what `active = false` is for. RESTRICT says so rather than leaving the rows
-- pointing at nothing.
ALTER TABLE "document_submission"
  ADD CONSTRAINT "document_submission_requirementId_fkey"
  FOREIGN KEY ("requirementId") REFERENCES "document_requirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

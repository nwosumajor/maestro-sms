-- The attestation a report card carries instead of a signature.
--
-- One row per pupil per term, so the code printed on a card is stable across
-- regenerations. `contentHash` is what decides whether a regenerated card is the
-- same document or a new version of it, and `version` is what a holder of an
-- older printout compares against.
CREATE TABLE "report_card_attestation" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "schoolId"       UUID NOT NULL,
  "studentId"      UUID NOT NULL,
  "termId"         UUID NOT NULL,
  "code"           TEXT NOT NULL,
  "approvedById"   UUID NOT NULL,
  "approvedByName" TEXT NOT NULL,
  "approvedByRole" TEXT NOT NULL,
  "approvedAt"     TIMESTAMP(3) NOT NULL,
  "termAverage"    DOUBLE PRECISION,
  "termGrade"      TEXT,
  "subjects"       JSONB NOT NULL,
  "contentHash"    TEXT NOT NULL,
  "version"        INTEGER NOT NULL DEFAULT 1,
  "issuedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL
);

-- One attestation per pupil per term: the code identifies the card, not the
-- printing of it.
CREATE UNIQUE INDEX "report_card_attestation_studentId_termId_key"
  ON "report_card_attestation" ("studentId", "termId");

-- The verification lookup. Tenant-leading because the public URL carries the
-- school's slug, so the read resolves the school FIRST and then runs under RLS —
-- no cross-tenant read, and the app role needs no extra reach.
CREATE UNIQUE INDEX "report_card_attestation_schoolId_code_key"
  ON "report_card_attestation" ("schoolId", "code");

CREATE INDEX "report_card_attestation_schoolId_idx"
  ON "report_card_attestation" ("schoolId");

ALTER TABLE "report_card_attestation"
  ADD CONSTRAINT "report_card_attestation_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "report_card_attestation"
  ADD CONSTRAINT "report_card_attestation_termId_fkey"
  FOREIGN KEY ("termId") REFERENCES "term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- WHEN THE HEAD SIGNED. `updatedAt` cannot answer this, because a class teacher
-- editing their own remark moves it, and the attestation says "Approved by X on
-- <date>". Nullable: rows written before this column existed have no answer, and
-- inventing one would be worse than falling back to `updatedAt` and saying so.
ALTER TABLE "report_card_remark" ADD COLUMN "headRemarkAt" TIMESTAMP(3);

-- =============================================================================
-- The link between an accepted application and the pupil it became
-- =============================================================================
-- There was none. An accepted family was enrolled by hand, and nothing tied the
-- application to the child — so the documents that family had already sent had
-- nowhere to go, and nobody could answer "which pupil is this application?".
--
-- UNIQUE is the idempotency guard: converting an application twice cannot make a
-- second pupil, and two applications cannot claim the same child. The FK is
-- SET NULL rather than RESTRICT — a pupil record removed for a data-protection
-- reason must not be blocked by, or take with it, the admission record of how
-- they arrived.
-- =============================================================================

ALTER TABLE "admission_application" ADD COLUMN "convertedStudentId" UUID;
ALTER TABLE "admission_application" ADD COLUMN "convertedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "admission_application_convertedStudentId_key"
  ON "admission_application" ("convertedStudentId");

ALTER TABLE "admission_application"
  ADD CONSTRAINT "admission_application_convertedStudentId_fkey"
  FOREIGN KEY ("convertedStudentId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

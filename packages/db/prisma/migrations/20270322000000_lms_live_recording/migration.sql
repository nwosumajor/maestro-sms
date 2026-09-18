-- A live session gains its COURSE and its RECORDING.
--
-- `subjectId` is nullable on purpose: a form-period or assembly session is a
-- real session with no subject, and requiring one would push a teacher into
-- picking a wrong answer to get past the form. No FK to `subject` here — the
-- repo's documented "scalar column + DB FK, no Prisma relation" pattern is used
-- where the relation would only bloat a model; the FK is added below so the
-- column cannot name a subject that does not exist.
ALTER TABLE "lms_live_session"
  ADD COLUMN IF NOT EXISTS "subjectId" UUID,
  ADD COLUMN IF NOT EXISTS "recordingKey" TEXT,
  ADD COLUMN IF NOT EXISTS "recordingSizeBytes" INTEGER,
  ADD COLUMN IF NOT EXISTS "recordingUploadedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "recordingExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "recordingRemovedAt" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lms_live_session_subjectId_fkey'
  ) THEN
    ALTER TABLE "lms_live_session"
      ADD CONSTRAINT "lms_live_session_subjectId_fkey"
      FOREIGN KEY ("subjectId") REFERENCES "subject"("id") ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

-- The cross-course listing pages newest-first within one school.
CREATE INDEX IF NOT EXISTS "lms_live_session_schoolId_startsAt_idx"
  ON "lms_live_session" ("schoolId", "startsAt" DESC);

-- THE RETENTION SWEEP IS A FLEET SWEEP, so it has no tenant to lead with: it
-- asks "which recordings anywhere are past their date", and an index leading
-- with "schoolId" cannot serve that. Partial, because a recording that is still
-- held is a rare row next to every session ever scheduled, and it drops out of
-- the index the moment the sweep clears it.
CREATE INDEX IF NOT EXISTS "lms_live_session_recording_due_idx"
  ON "lms_live_session" ("recordingExpiresAt")
  WHERE "recordingKey" IS NOT NULL;

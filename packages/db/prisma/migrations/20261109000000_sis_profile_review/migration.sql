-- =============================================================================
-- SIS profile completion + two-stage review
-- =============================================================================
-- A bulk-imported pupil arrives with a name and nothing else (that is the point of
-- name-only import). These columns drive the loop that turns that into a real
-- record: the pupil fills the profile in, SUBMITs it, their CLASS SUPERVISOR
-- checks it, and the SCHOOL ADMIN approves — or sends it back with a note.
--
-- Existing profiles are backfilled by INSPECTION rather than assumption: a profile
-- that already holds the required identity/contact fields is treated as APPROVED
-- (a school that has been running should not have its whole roll suddenly told to
-- re-enter data it already supplied); anything genuinely sparse starts INCOMPLETE.
-- =============================================================================

ALTER TABLE "student_profile" ADD COLUMN "profileStatus"          TEXT NOT NULL DEFAULT 'INCOMPLETE';
ALTER TABLE "student_profile" ADD COLUMN "submittedAt"            TIMESTAMP(3);
ALTER TABLE "student_profile" ADD COLUMN "supervisorReviewedById" UUID;
ALTER TABLE "student_profile" ADD COLUMN "supervisorReviewedAt"   TIMESTAMP(3);
ALTER TABLE "student_profile" ADD COLUMN "approvedById"           UUID;
ALTER TABLE "student_profile" ADD COLUMN "approvedAt"             TIMESTAMP(3);
ALTER TABLE "student_profile" ADD COLUMN "reviewNote"             TEXT;
ALTER TABLE "student_profile" ADD COLUMN "lastNudgedAt"           TIMESTAMP(3);

-- Backfill: an already-complete profile is not asked to re-do itself. Mirrors
-- SIS_REQUIRED_PROFILE_FIELDS in @sms/types — keep the two in step.
UPDATE "student_profile"
SET "profileStatus" = 'APPROVED',
    "approvedAt"    = COALESCE("updatedAt", now())
WHERE "dateOfBirth"  IS NOT NULL
  AND COALESCE(btrim("gender"), '')       <> ''
  AND COALESCE(btrim("phone"), '')        <> ''
  AND COALESCE(btrim("addressLine1"), '') <> ''
  AND COALESCE(btrim("city"), '')         <> ''
  AND COALESCE(btrim("state"), '')        <> '';

-- The nudge sweep and the review queue both filter on status.
CREATE INDEX "student_profile_schoolId_profileStatus_idx"
  ON "student_profile"("schoolId", "profileStatus");

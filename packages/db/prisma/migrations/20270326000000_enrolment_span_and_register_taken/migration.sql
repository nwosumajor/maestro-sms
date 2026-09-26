-- =============================================================================
-- When a pupil LEFT a class, and whether a register was actually TAKEN
-- =============================================================================
-- Two facts the attendance figures need and the schema could not answer.
--
-- 1. enrollment."endedAt" — an enrolment recorded when it BEGAN and never when it
--    ENDED, so "was this pupil in this class on the 12th?" had no exact answer.
--    Counting the registers a pupil SHOULD have been on (to show the days nobody
--    recorded them) would otherwise charge a pupil who moved class with every
--    register their OLD class took after they left.
--
--    Kept by a TRIGGER, not by the application, on purpose: five writers close or
--    reopen an enrolment (promotion twice, demotion's reactivation, the student
--    exit, a transfer/withdrawal) and a rule written five times is right four
--    times. The trigger covers raw SQL and writers not yet written.
--      ACTIVE -> anything else : endedAt = now
--      anything else -> ACTIVE : endedAt = NULL and enrolledAt = now. One row per
--        (class, pupil) cannot hold two spans, so a reopened enrolment starts a
--        new span; the earlier one's start is given up. That can only UNDER-count
--        unrecorded days for it, never over-count, and a reopen happens at a
--        promotion — a session boundary, behind the term lock.
--    Timestamps are written in UTC explicitly: these are `timestamp without time
--    zone` columns read by Prisma as UTC, and `now()` would otherwise be stored in
--    the DB session's local zone.
--
-- 2. attendance_session."takenAt" — the scan desk CREATES a class's register the
--    moment one pupil checks in, and the reminder and the register board both
--    treated "a register row exists" as "the register was taken". One early scan
--    silenced the class teacher's reminder and filed the class under Taken with
--    one pupil of thirty marked. takenAt is set only when the register itself is
--    saved (AttendanceService.applyRegister), never by a scan.
-- =============================================================================

ALTER TABLE "enrollment" ADD COLUMN "endedAt" TIMESTAMP(3);

-- BACKFILL, for enrolments already closed. The true end is unknown; the best
-- evidence is the last day the pupil was recorded in that class, so the span
-- ends the day AFTER it (that last recorded day stays inside it). A closed
-- enrolment with no record at all ends where it began: never on a register.
UPDATE "enrollment" e
SET "endedAt" = COALESCE(
  (SELECT max(r."date")::timestamp + INTERVAL '1 day'
     FROM "attendance_record" r
     JOIN "attendance_session" s ON s."id" = r."sessionId" AND s."date" = r."date"
    WHERE s."classId" = e."classId" AND r."studentId" = e."studentId"),
  e."enrolledAt")
WHERE e."status" <> 'ACTIVE';

CREATE OR REPLACE FUNCTION enrollment_track_span() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' AND NEW."endedAt" IS NULL THEN
      NEW."endedAt" := NEW."enrolledAt";
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."status" = 'ACTIVE' THEN
      NEW."endedAt" := NULL;
      NEW."enrolledAt" := (now() AT TIME ZONE 'UTC');
    ELSIF OLD."status" = 'ACTIVE' THEN
      NEW."endedAt" := (now() AT TIME ZONE 'UTC');
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "enrollment_track_span"
BEFORE INSERT OR UPDATE OF "status" ON "enrollment"
FOR EACH ROW EXECUTE FUNCTION enrollment_track_span();

ALTER TABLE "attendance_session" ADD COLUMN "takenAt" TIMESTAMP(3);

-- BACKFILL: a register was TAKEN if anything other than a gate scan wrote to it.
-- A session whose every record is a scan check-in was only ever started by the
-- desk. (The register's own save rewrites each record's note, so a scan-started
-- session a teacher later completed carries non-scan notes.)
UPDATE "attendance_session" s
SET "takenAt" = s."updatedAt"
WHERE EXISTS (
  SELECT 1 FROM "attendance_record" r
  WHERE r."sessionId" = s."id" AND r."date" = s."date"
    AND r."note" IS DISTINCT FROM 'scan check-in'
) OR NOT EXISTS (
  SELECT 1 FROM "attendance_record" r WHERE r."sessionId" = s."id" AND r."date" = s."date"
);

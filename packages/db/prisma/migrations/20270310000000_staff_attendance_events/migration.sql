-- Staff attendance: a day is a SPAN, not a stamp.
--
-- `staff_attendance` held one write-once row per person per day carrying only
-- `clockInAt`. Departure scans were already arriving from gate terminals and
-- being discarded as duplicates, so no hours could be computed from what was
-- kept, and an authorised absence looked exactly like a no-show.

ALTER TABLE "staff_attendance" ADD COLUMN IF NOT EXISTS "clockOutAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "staff_attendance_event" (
  "id"        UUID NOT NULL,
  "schoolId"  UUID NOT NULL,
  "userId"    UUID NOT NULL,
  "date"      DATE NOT NULL,
  "kind"      TEXT NOT NULL,
  "at"        TIMESTAMP(3) NOT NULL,
  "source"    TEXT NOT NULL,
  "deviceId"  UUID,
  "ip"        TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_attendance_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "staff_attendance_event_schoolId_idx"
  ON "staff_attendance_event" ("schoolId");
CREATE INDEX IF NOT EXISTS "staff_attendance_event_schoolId_date_idx"
  ON "staff_attendance_event" ("schoolId", "date");
-- The sweep and the day-row projection both read one person's day.
CREATE INDEX IF NOT EXISTS "staff_attendance_event_schoolId_userId_date_idx"
  ON "staff_attendance_event" ("schoolId", "userId", "date");

DO $$ BEGIN
  ALTER TABLE "staff_attendance_event"
    ADD CONSTRAINT "staff_attendance_event_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- BACKFILL: every existing day row already carries the arrival it was created
-- from. Without this the log would begin empty and the projection would read as
-- though nobody had ever clocked in before today.
INSERT INTO "staff_attendance_event" ("id","schoolId","userId","date","kind","at","source","ip","createdAt")
SELECT gen_random_uuid(), "schoolId", "userId", "date", 'IN', "clockInAt", "source", "ip", "createdAt"
FROM "staff_attendance"
WHERE "clockInAt" IS NOT NULL;

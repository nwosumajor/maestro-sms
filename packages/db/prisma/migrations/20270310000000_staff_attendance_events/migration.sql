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
-- IDEMPOTENT, because every other statement in this file is: without the guard a
-- re-run (or a hand-applied migration later recorded as applied) would give every
-- existing day a SECOND arrival event. Harmless to the first/last projection,
-- junk in the record it is meant to be.
INSERT INTO "staff_attendance_event" ("id","schoolId","userId","date","kind","at","source","ip","createdAt")
SELECT gen_random_uuid(), a."schoolId", a."userId", a."date", 'IN', a."clockInAt", a."source", a."ip", a."createdAt"
FROM "staff_attendance" a
WHERE a."clockInAt" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "staff_attendance_event" e
    WHERE e."userId" = a."userId" AND e."date" = a."date"
  );

-- The per-staff monthly history reads ONE person's whole record to compile it,
-- which is O(how long they have worked here): ~250 rows a year, so a colleague
-- in year eight costs eight times what a new one does for the same screen.
--
-- MEASURED as the app role, under RLS, with a bound parameter, on 250,440 rows
-- (120 staff x 8 years) in the test database:
--
--   existing (userId,date) only          Bitmap Heap Scan   41.8 ms
--   plain (schoolId,userId,date)         Index Scan         34.8 ms
--   this one, with INCLUDE               Index Only Scan    12.5 ms
--
-- The INCLUDE is what removes the heap fetch, and it is the whole difference —
-- the plain composite barely pays for itself. Carried here rather than in the
-- Prisma schema because `INCLUDE` has no Prisma syntax, the same reason the
-- documented FK-only-in-migrations objects live here.
CREATE INDEX IF NOT EXISTS "staff_attendance_schoolId_userId_date_idx"
  ON "staff_attendance" ("schoolId", "userId", "date")
  INCLUDE (status, flagged, "clockInAt", "clockOutAt");

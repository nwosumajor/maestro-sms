-- A class's BASE ROOM — "SS1A stays in Hall A".
--
-- `class_subject_offering.preferredRoomId` already pinned a SUBJECT to a
-- specialist room (Chemistry -> the lab). Nothing said where the cohort itself
-- lives, so there was no answer to "which room is SS1A in?" — the question a
-- visitor, a cover teacher and a parent all ask first.

ALTER TABLE "class" ADD COLUMN IF NOT EXISTS "homeRoomId" UUID;

DO $$ BEGIN
  ALTER TABLE "class"
    ADD CONSTRAINT "class_homeRoomId_fkey"
    FOREIGN KEY ("homeRoomId") REFERENCES "room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ON DELETE SET NULL, deliberately: deleting a room must not take the class with
-- it, and a class whose room is gone is honestly "no room" rather than a
-- dangling id.

-- ONE CLASS PER ROOM. A base room is where a cohort IS, so two classes claiming
-- the same one is a data error in almost every school — and the partial index
-- leaves NULL free, so any number of classes may have no base room at all.
CREATE UNIQUE INDEX IF NOT EXISTS "class_schoolId_homeRoomId_key"
  ON "class" ("schoolId", "homeRoomId") WHERE "homeRoomId" IS NOT NULL;

-- Serves "which class is in this room?" without scanning the class table.
CREATE INDEX IF NOT EXISTS "class_homeRoomId_idx" ON "class" ("homeRoomId");

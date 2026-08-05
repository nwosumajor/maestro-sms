-- Additional staff attending a meeting alongside its organiser.
--
-- meeting_slot.teacherId stays the ORGANISER: it decides who may withdraw the
-- slot and whose list it appears in as their own. A second column would cap this
-- at two people, and replacing teacherId would lose the "who owns this" answer
-- three other behaviours already depend on.
CREATE TABLE "meeting_cohost" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "schoolId"  UUID NOT NULL REFERENCES "school"("id") ON DELETE RESTRICT,
  "slotId"    UUID NOT NULL REFERENCES "meeting_slot"("id") ON DELETE CASCADE,
  "teacherId" UUID NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Adding the same colleague twice is a no-op, not two seats.
CREATE UNIQUE INDEX "meeting_cohost_slotId_teacherId_key" ON "meeting_cohost" ("slotId", "teacherId");
CREATE INDEX "meeting_cohost_schoolId_idx" ON "meeting_cohost" ("schoolId");
-- "Which meetings am I attending?" — the co-host's own list.
CREATE INDEX "meeting_cohost_schoolId_teacherId_idx" ON "meeting_cohost" ("schoolId", "teacherId");

-- Hand-picked parents for a SELECTED meeting, and the index that removes the
-- capacity-claim contention from a briefing.

CREATE TABLE "meeting_invitee" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "schoolId"  UUID NOT NULL REFERENCES "school"("id") ON DELETE RESTRICT,
  "slotId"    UUID NOT NULL REFERENCES "meeting_slot"("id") ON DELETE CASCADE,
  "parentId"  UUID NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Inviting the same parent twice is a no-op, not two invitations.
CREATE UNIQUE INDEX "meeting_invitee_slotId_parentId_key" ON "meeting_invitee" ("slotId", "parentId");
CREATE INDEX "meeting_invitee_schoolId_idx" ON "meeting_invitee" ("schoolId");

-- A briefing records attendance WITHOUT a capacity claim.
--
-- `book()` COUNTs every existing booking on the slot inside each transaction to
-- enforce capacity. For an appointment that is correct — it allocates a scarce
-- thing and must serialise. For a whole-school meeting it is O(n^2) reads all
-- contending on the same rows, which is precisely how 2,000 parents responding
-- to one notice would take the system down.
--
-- This unique index makes the duplicate check a constraint rather than a query,
-- so an RSVP is a single INSERT that either lands or conflicts. No COUNT, no
-- read of anyone else's row, no contention.
CREATE UNIQUE INDEX "meeting_booking_slotId_parentId_key"
  ON "meeting_booking" ("slotId", "parentId") WHERE "status" = 'BOOKED';

-- APPOINTMENT | BRIEFING — whether this meeting allocates a scarce thing.
--
-- Stored rather than derived from the audience, because they are not the same
-- question. A plain bookable slot has no declared audience and so defaults to
-- SCHOOL, but it IS an appointment: one teacher, one half-hour, capacity
-- genuinely enforced. Deriving from the audience removed the capacity claim from
-- every ordinary slot.
--
-- APPOINTMENT is the correct default for every existing row: that is what they
-- all are.
ALTER TABLE "meeting_slot" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'APPOINTMENT';

-- WHO a meeting is for, and which year group a class belongs to.
--
-- The meetings page modelled only a bookable 1:1 slot, and every parent in the
-- school saw every open slot with nothing saying which were meant for them.
-- A principal calling a year-group or whole-school meeting could not express it
-- at all.

-- The year group, using the SUBJECT_STAGES vocabulary the subject catalogue
-- already uses. NULL = ungrouped, and an ungrouped class is never swept up by a
-- year-group meeting — the safe direction.
ALTER TABLE "class" ADD COLUMN "stage" TEXT;
CREATE INDEX "class_schoolId_stage_idx" ON "class" ("schoolId", "stage");

-- SCHOOL is the correct default for every existing slot: that is precisely what
-- they already were — visible to every parent who could book. Nobody's current
-- meetings change.
ALTER TABLE "meeting_slot" ADD COLUMN "audienceKind" TEXT NOT NULL DEFAULT 'SCHOOL';
ALTER TABLE "meeting_slot" ADD COLUMN "audienceRef" TEXT;

-- The parent-side query filters on (kind, ref) to decide which slots are for
-- this family, on a table that grows every term.
CREATE INDEX "meeting_slot_schoolId_audience_idx"
  ON "meeting_slot" ("schoolId", "audienceKind", "audienceRef");

-- Streams and arms as STRUCTURED fields, not a naming convention.
--
-- "SS3 Science A" lived entirely in class.name, so "all SS3 Science classes"
-- could only be a string match — and the string drifted between schools and
-- between sessions ("SS3 Sci A", "SS3-SCIENCE-A", "SS3 Science 1").
--
-- Both nullable: a junior class has no stream, a single-class stream has no
-- arm, and every class that already exists keeps working untouched.

ALTER TABLE "class" ADD COLUMN IF NOT EXISTS "stream" TEXT;
ALTER TABLE "class" ADD COLUMN IF NOT EXISTS "arm" TEXT;

-- Grouping a year's streams and arms is the query behind stream ranking, the
-- subject-set copy and stream-wide announcements. Without this index it is a
-- sequential scan of every class in the school, on a path the class list hits
-- on every load.
CREATE INDEX IF NOT EXISTS "class_schoolId_stage_level_stream_idx"
  ON "class" ("schoolId", "stage", "level", "stream");

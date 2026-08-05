-- Timetable double-booking, enforced at the DB.
--
-- assertNoConflict SELECTs then INSERTs. That is not atomic: firing 12
-- concurrent bookings of one teacher's slot let 2 through, and both returned
-- 201. The class rule already had a unique constraint and held under the same
-- test; teacher and room had only indexes, so they corrupted silently.
--
-- Promoting the two indexes to unique constraints costs nothing — the column
-- lists are identical, so the same lookups stay index-backed.
--
-- roomId is nullable. Postgres treats NULLs as DISTINCT in a unique index, so
-- any number of lessons with no room assigned coexist happily; only two lessons
-- naming the SAME room in the same slot collide.
--
-- Verified no pre-existing violations before adding these. If a deploy fails
-- here, the DB already contains a double-booking the old code let through:
-- find it with the GROUP BY ... HAVING count(*) > 1 of the same columns and
-- resolve it deliberately — do NOT weaken the constraint to get past it.

DROP INDEX IF EXISTS "timetable_entry_schoolId_teacherId_dayOfWeek_periodId_idx";
DROP INDEX IF EXISTS "timetable_entry_schoolId_roomId_dayOfWeek_periodId_idx";

CREATE UNIQUE INDEX "timetable_entry_schoolId_teacherId_dayOfWeek_periodId_key"
  ON "timetable_entry" ("schoolId", "teacherId", "dayOfWeek", "periodId");

CREATE UNIQUE INDEX "timetable_entry_schoolId_roomId_dayOfWeek_periodId_key"
  ON "timetable_entry" ("schoolId", "roomId", "dayOfWeek", "periodId");

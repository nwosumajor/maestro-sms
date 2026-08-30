-- =============================================================================
-- Retire `class_teacher`: a class teacher IS the class supervisor
-- =============================================================================
-- A class teacher, a form teacher and a class supervisor are one person with
-- one job: monitor the class, take its register, answer for it. A SUBJECT
-- teacher is a different relationship — eleven subjects to one class, eleven
-- people, none of them taking the register — and keeps `class_subject_teacher`.
--
-- The platform stored the first concept TWICE: `class.supervisorId` (single,
-- read by attendance) and `class_teacher` (many-to-many, written by the visible
-- "assign teacher" action). Only the second was written, so a school assigned a
-- class teacher and that person could not take their own register.
--
-- BACKFILL BEFORE DROPPING, AND NEVER OVERWRITE. On the school this was found
-- on the two already agreed, but a deployment where they diverge must not lose
-- the assignment: a class with no supervisor takes the teacher from its join
-- row, and a class that already has one keeps it. A class with SEVERAL join
-- rows — the shape the many-to-many allowed and the product never intended —
-- takes the EARLIEST, which is the one a school assigned first.
UPDATE "class" c
SET "supervisorId" = t."teacherId"
FROM (
  SELECT DISTINCT ON ("classId") "classId", "teacherId"
  FROM "class_teacher"
  ORDER BY "classId", "createdAt" ASC
) t
WHERE c.id = t."classId" AND c."supervisorId" IS NULL;

-- The column stays NULLABLE on purpose. Every class must have a class teacher
-- and the API enforces that on create and refuses to remove one, but classes
-- that predate the rule have none and there is no correct value to invent for
-- them — who runs a class is the school's answer. NOT NULL is the last step and
-- belongs to the day the "no form teacher" report reads zero.
DROP TABLE IF EXISTS "class_teacher";

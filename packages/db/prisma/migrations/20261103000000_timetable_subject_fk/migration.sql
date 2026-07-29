-- =============================================================================
-- TimetableEntry.subject (free text) -> subjectId foreign key
-- =============================================================================
-- A lesson named its subject as a STRING, so the timetable could reference a
-- subject that does not exist in the registry (or a differently-typed variant of
-- one that does). That breaks the joins everything else relies on: class-subject
-- offerings, teacher scoping, grading and CBT bank access all key on subject.id.
--
-- `subject` survives as a DENORMALISED display label, but it is now a
-- server-maintained copy of the Subject's name rather than operator text.
--
-- Backfill promotes each distinct label to a real Subject per school
-- (find-or-create, case-insensitive), then makes the column NOT NULL + FK.
-- =============================================================================

ALTER TABLE "timetable_entry" ADD COLUMN "subjectId" UUID;

-- 1. Create any Subject referenced only by a timetable label.
INSERT INTO "subject" (id, "schoolId", name, code, "createdAt", "updatedAt")
SELECT gen_random_uuid(), t."schoolId", btrim(t."subject"),
       CASE
         WHEN EXISTS (
           SELECT 1 FROM "subject" s2
           WHERE s2."schoolId" = t."schoolId"
             AND s2.code = upper(left(regexp_replace(t."subject", '[^a-zA-Z0-9]', '', 'g'), 8))
         )
         THEN left(upper(left(regexp_replace(t."subject", '[^a-zA-Z0-9]', '', 'g'), 6)) || left(replace(gen_random_uuid()::text,'-',''), 2), 8)
         ELSE upper(left(regexp_replace(t."subject", '[^a-zA-Z0-9]', '', 'g'), 8))
       END,
       now(), now()
FROM (
  SELECT DISTINCT "schoolId", btrim("subject") AS "subject"
  FROM "timetable_entry"
  WHERE "subject" IS NOT NULL AND btrim("subject") <> ''
) t
WHERE NOT EXISTS (
  SELECT 1 FROM "subject" s
  WHERE s."schoolId" = t."schoolId" AND lower(s.name) = lower(btrim(t."subject"))
);

-- 2. Point each lesson at its subject.
UPDATE "timetable_entry" t
SET "subjectId" = s.id
FROM "subject" s
WHERE t."subjectId" IS NULL
  AND s."schoolId" = t."schoolId"
  AND lower(s.name) = lower(btrim(t."subject"));

-- 3. Lessons with a blank label (should not exist) fall back to a per-school
--    "General" subject rather than blocking the migration.
INSERT INTO "subject" (id, "schoolId", name, code, "createdAt", "updatedAt")
SELECT gen_random_uuid(), t."schoolId", 'General', 'GENERAL', now(), now()
FROM (SELECT DISTINCT "schoolId" FROM "timetable_entry" WHERE "subjectId" IS NULL) t
WHERE NOT EXISTS (
  SELECT 1 FROM "subject" s WHERE s."schoolId" = t."schoolId" AND lower(s.name) = 'general'
);

UPDATE "timetable_entry" t
SET "subjectId" = s.id, "subject" = s.name
FROM "subject" s
WHERE t."subjectId" IS NULL AND s."schoolId" = t."schoolId" AND lower(s.name) = 'general';

-- 4. Re-sync the label to the registry name, then lock the column down.
UPDATE "timetable_entry" t
SET "subject" = s.name
FROM "subject" s
WHERE t."subjectId" = s.id AND t."subject" IS DISTINCT FROM s.name;

ALTER TABLE "timetable_entry" ALTER COLUMN "subjectId" SET NOT NULL;

ALTER TABLE "timetable_entry"
  ADD CONSTRAINT "timetable_entry_subjectId_fkey"
  FOREIGN KEY ("subjectId") REFERENCES "subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "timetable_entry_schoolId_subjectId_idx" ON "timetable_entry"("schoolId", "subjectId");

-- =============================================================================
-- CBT question banks: subjectId becomes REQUIRED
-- =============================================================================
-- A bank carried a free-text `subject` label alongside a NULLABLE `subjectId`.
-- Because teacher access is decided by subject (classSubjectTeacher), a bank
-- with a NULL subjectId is invisible and un-fillable to EVERY teacher — it can
-- only ever be edited by school-wide staff. That is a silent trap: an admin
-- creates a bank, picks no subject, and no teacher can contribute to it.
--
-- Backfill promotes each label to a real Subject row (find-or-create by name,
-- per school), then makes the column NOT NULL so the trap cannot recur.
-- =============================================================================

-- 1. Create any Subject a bank references only by label. Codes follow the same
--    derivation as 20261101000000 and are de-duplicated against existing codes.
INSERT INTO "subject" (id, "schoolId", name, code, "createdAt", "updatedAt")
SELECT gen_random_uuid(),
       b."schoolId",
       btrim(b."subject"),
       -- derive, then suffix if that code is already taken in this school
       CASE
         WHEN EXISTS (
           SELECT 1 FROM "subject" s2
           WHERE s2."schoolId" = b."schoolId"
             AND s2.code = upper(left(regexp_replace(b."subject", '[^a-zA-Z0-9]', '', 'g'), 8))
         )
         THEN left(upper(left(regexp_replace(b."subject", '[^a-zA-Z0-9]', '', 'g'), 6)) || left(replace(gen_random_uuid()::text,'-',''), 2), 8)
         ELSE upper(left(regexp_replace(b."subject", '[^a-zA-Z0-9]', '', 'g'), 8))
       END,
       now(), now()
FROM (
  SELECT DISTINCT "schoolId", btrim("subject") AS "subject"
  FROM "cbt_question_bank"
  WHERE "subjectId" IS NULL
    AND "subject" IS NOT NULL
    AND btrim("subject") <> ''
) b
WHERE NOT EXISTS (
  SELECT 1 FROM "subject" s
  WHERE s."schoolId" = b."schoolId" AND lower(s.name) = lower(btrim(b."subject"))
);

-- 2. Point those banks at the subject that now exists.
UPDATE "cbt_question_bank" b
SET "subjectId" = s.id
FROM "subject" s
WHERE b."subjectId" IS NULL
  AND b."subject" IS NOT NULL
  AND s."schoolId" = b."schoolId"
  AND lower(s.name) = lower(btrim(b."subject"));

-- 3. Banks with NO label at all fall back to a per-school "General" subject.
INSERT INTO "subject" (id, "schoolId", name, code, "createdAt", "updatedAt")
SELECT gen_random_uuid(), b."schoolId", 'General', 'GENERAL', now(), now()
FROM (SELECT DISTINCT "schoolId" FROM "cbt_question_bank" WHERE "subjectId" IS NULL) b
WHERE NOT EXISTS (
  SELECT 1 FROM "subject" s WHERE s."schoolId" = b."schoolId" AND lower(s.name) = 'general'
);

UPDATE "cbt_question_bank" b
SET "subjectId" = s.id, "subject" = s.name
FROM "subject" s
WHERE b."subjectId" IS NULL
  AND s."schoolId" = b."schoolId"
  AND lower(s.name) = 'general';

-- 4. Keep the denormalised label consistent with the registry from here on.
UPDATE "cbt_question_bank" b
SET "subject" = s.name
FROM "subject" s
WHERE b."subjectId" = s.id AND (b."subject" IS DISTINCT FROM s.name);

ALTER TABLE "cbt_question_bank" ALTER COLUMN "subjectId" SET NOT NULL;

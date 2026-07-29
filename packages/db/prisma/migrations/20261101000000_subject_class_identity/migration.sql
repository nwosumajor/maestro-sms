-- =============================================================================
-- Subject / Class identity integrity
-- =============================================================================
-- Nothing at the DB level stopped a school holding two subjects called
-- "Mathematics" (or two classes called "JSS2A"). Duplicates silently SPLIT
-- teacher assignments, enrollments and question banks across rows that look
-- identical in every picker — the accuracy problem this migration closes.
--
-- Both tables gain a stable per-school `code` (the key imports and rosters
-- should reference instead of a free-text name), backfilled from the name, plus
-- uniqueness on BOTH name and code.
--
-- Backfill is written to be safe on live data: codes derive from the name, are
-- de-duplicated with a numeric suffix, and names are only ever read, never
-- rewritten. If a school already holds duplicate NAMES the unique index will
-- fail loudly rather than silently merge them — that is deliberate; such data
-- needs a human decision about which row is canonical.
-- =============================================================================

-- --- Subject.code: nullable -> backfilled -> NOT NULL ------------------------
-- Code = first 3 alphanumerics of each word, uppercased, capped at 8 chars;
-- collisions within a school get a numeric suffix.
UPDATE "subject" s
SET "code" = sub.candidate
FROM (
  SELECT id,
         upper(left(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g'), 8))
           || CASE WHEN rn = 1 THEN '' ELSE rn::text END AS candidate
  FROM (
    SELECT id, name, "schoolId",
           row_number() OVER (
             PARTITION BY "schoolId", upper(left(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g'), 8))
             ORDER BY "createdAt", id
           ) AS rn
    FROM "subject"
    WHERE "code" IS NULL OR btrim("code") = ''
  ) t
) sub
WHERE s.id = sub.id;

-- Any row still blank (e.g. a name with no alphanumerics) gets a stable fallback.
UPDATE "subject" SET "code" = 'SUBJ' || left(replace(id::text, '-', ''), 6)
WHERE "code" IS NULL OR btrim("code") = '';

ALTER TABLE "subject" ALTER COLUMN "code" SET NOT NULL;

-- --- Class.code: new column -> backfilled -> NOT NULL ------------------------
ALTER TABLE "class" ADD COLUMN "code" TEXT;

UPDATE "class" c
SET "code" = sub.candidate
FROM (
  SELECT id,
         upper(left(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g'), 8))
           || CASE WHEN rn = 1 THEN '' ELSE rn::text END AS candidate
  FROM (
    SELECT id, name, "schoolId",
           row_number() OVER (
             PARTITION BY "schoolId", upper(left(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g'), 8))
             ORDER BY "createdAt", id
           ) AS rn
    FROM "class"
  ) t
) sub
WHERE c.id = sub.id;

UPDATE "class" SET "code" = 'CLS' || left(replace(id::text, '-', ''), 6)
WHERE "code" IS NULL OR btrim("code") = '';

ALTER TABLE "class" ALTER COLUMN "code" SET NOT NULL;


-- A DB-level default so ANY direct-SQL insert (a school's own tooling, a fixture,
-- a data-load script) still yields a unique code instead of violating NOT NULL.
-- The application always writes a NAME-DERIVED code via deriveEntityCode; this is
-- purely the safety net for writers that bypass it.
ALTER TABLE "subject" ALTER COLUMN "code" SET DEFAULT left(replace(gen_random_uuid()::text, '-', ''), 8);
ALTER TABLE "class"   ALTER COLUMN "code" SET DEFAULT left(replace(gen_random_uuid()::text, '-', ''), 8);

-- --- Uniqueness --------------------------------------------------------------
CREATE UNIQUE INDEX "subject_schoolId_name_key" ON "subject"("schoolId", "name");
CREATE UNIQUE INDEX "subject_schoolId_code_key" ON "subject"("schoolId", "code");
CREATE UNIQUE INDEX "class_schoolId_name_key"   ON "class"("schoolId", "name");
CREATE UNIQUE INDEX "class_schoolId_code_key"   ON "class"("schoolId", "code");

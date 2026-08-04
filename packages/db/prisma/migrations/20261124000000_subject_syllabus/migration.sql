-- The scheme of work a subject teacher plans and works to for one term.
--
-- LmsContent holds individual items but nothing said what the TERM is meant to
-- cover, so "are we on schedule" could not be answered without reading every
-- item and remembering the plan.

CREATE TABLE "subject_syllabus" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "schoolId"  UUID NOT NULL REFERENCES "school"("id") ON DELETE RESTRICT,
  "classId"   UUID NOT NULL REFERENCES "class"("id") ON DELETE CASCADE,
  "subjectId" UUID NOT NULL REFERENCES "subject"("id") ON DELETE RESTRICT,
  "termId"    UUID NOT NULL REFERENCES "term"("id") ON DELETE RESTRICT,
  "overview"  TEXT,
  "ownerId"   UUID NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

-- One plan per subject per class per term. Two would make "the plan" ambiguous
-- and every progress figure below it arbitrary.
CREATE UNIQUE INDEX "subject_syllabus_classId_subjectId_termId_key"
  ON "subject_syllabus" ("classId", "subjectId", "termId");
CREATE INDEX "subject_syllabus_schoolId_idx" ON "subject_syllabus" ("schoolId");
CREATE INDEX "subject_syllabus_schoolId_subjectId_idx" ON "subject_syllabus" ("schoolId", "subjectId");

CREATE TABLE "subject_syllabus_item" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "schoolId"   UUID NOT NULL REFERENCES "school"("id") ON DELETE RESTRICT,
  -- Cascade: an item has no meaning without its plan, and leaving orphans behind
  -- would make the progress count wrong rather than merely incomplete.
  "syllabusId" UUID NOT NULL REFERENCES "subject_syllabus"("id") ON DELETE CASCADE,
  "week"       INTEGER NOT NULL,
  "topic"      TEXT NOT NULL,
  "objectives" TEXT,
  "resources"  TEXT,
  "status"     TEXT NOT NULL DEFAULT 'PLANNED',
  "taughtAt"   TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL
);
CREATE INDEX "subject_syllabus_item_schoolId_idx" ON "subject_syllabus_item" ("schoolId");
CREATE INDEX "subject_syllabus_item_syllabusId_idx" ON "subject_syllabus_item" ("syllabusId");

-- ---------------------------------------------------------------------------
-- Two FK columns that have been unindexed since they were added.
--
-- Neither hurts today at demo scale. Both are filtered by subject on pages a
-- teacher opens constantly, and both grow every term for the life of the school
-- — lms_content fastest of all, since it holds every material, lesson, quiz and
-- forum thread. An unindexed FK on a table that only grows is precisely the
-- shape of a query that is instant for two years and then is not.
CREATE INDEX IF NOT EXISTS "lms_content_schoolId_subjectId_idx" ON "lms_content" ("schoolId", "subjectId");
CREATE INDEX IF NOT EXISTS "cbt_question_bank_schoolId_subjectId_idx" ON "cbt_question_bank" ("schoolId", "subjectId");

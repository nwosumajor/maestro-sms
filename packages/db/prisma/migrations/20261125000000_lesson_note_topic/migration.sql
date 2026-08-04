-- Attach a piece of learning content to the syllabus TOPIC it teaches.
--
-- NULL is the ordinary state and stays valid: most class content is not tied to
-- a week of the plan, and everything that exists today is in that state.
--
-- ON DELETE SET NULL rather than CASCADE, deliberately. Removing a week from a
-- plan must never delete the lesson notes a teacher wrote for it — the plan is a
-- schedule, the notes are the work.
ALTER TABLE "lms_content" ADD COLUMN "syllabusItemId" UUID;
ALTER TABLE "lms_content"
  ADD CONSTRAINT "lms_content_syllabusItemId_fkey"
  FOREIGN KEY ("syllabusItemId") REFERENCES "subject_syllabus_item"("id") ON DELETE SET NULL;

-- The lookup the syllabus panel makes for every week it draws.
CREATE INDEX "lms_content_syllabusItemId_idx" ON "lms_content" ("syllabusItemId");

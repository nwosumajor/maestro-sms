-- =============================================================================
-- CBT: level + topic targeting, and exam blueprints
-- =============================================================================
-- A question bank was scoped to a SUBJECT only, so a single "Physics" bank gave
-- SS1A, SS2A and SS3A the identical pool — an SS1 pupil could draw an SS3
-- question. The only accurate workaround was one bank per level, which duplicates
-- every shared question and lets a teacher point the SS3 bank at SS1A by mistake.
--
-- Questions now carry:
--   * `level`  — the curriculum level they target (Class.level). NULL = any
--     level, so genuinely general questions are written once and reused. An exam
--     for SS1A draws only level=SS1 or level IS NULL, so streams SS1A/SS1B share
--     their level's questions with no copies.
--   * `topic`  — optional syllabus topic, so an exam can draw a BALANCED paper.
--
-- And an exam may carry a `blueprint` ([{topic,count}]): every pupil then gets the
-- same syllabus coverage with different questions.
--
-- Both question columns are indexed because sampling now FILTERS on them: without
-- these, starting a sitting would scan the whole bank as it grows.
-- =============================================================================

ALTER TABLE "cbt_question" ADD COLUMN "level" INTEGER;
ALTER TABLE "cbt_question" ADD COLUMN "topic" TEXT;

CREATE INDEX IF NOT EXISTS "cbt_question_bankId_level_idx" ON "cbt_question"("bankId", "level");
CREATE INDEX IF NOT EXISTS "cbt_question_bankId_topic_idx" ON "cbt_question"("bankId", "topic");

ALTER TABLE "cbt_exam" ADD COLUMN "blueprint" JSONB;

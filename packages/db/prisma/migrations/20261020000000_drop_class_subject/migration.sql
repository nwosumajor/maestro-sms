-- Drop the vestigial free-text Class.subject. A class is a COHORT that takes many
-- subjects; the real subject↔class↔teacher data lives in class_subject_teacher.
-- The column was write-only (never read anywhere), so no data of value is lost.
ALTER TABLE "class" DROP COLUMN "subject";

-- Tag LMS quizzes/assignments with a gradebook (subject, term) so a subject
-- teacher can pull their aggregated LMS score into the SubjectResult
-- "assignment" CA component. Both NULL = the content does not feed the report
-- card. Nullable, no backfill; existing content stays untagged.
ALTER TABLE "lms_content" ADD COLUMN "subjectId" UUID;
ALTER TABLE "lms_content" ADD COLUMN "termId" UUID;

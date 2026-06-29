-- File-upload assignment submissions, teacher-toggled per assessment.
--  - assessment.fileUploadEnabled: the teacher switch (default OFF / text-only).
--  - submission.fileKey/fileName/fileUploaded: the student's optional FILE answer
--    (bytes in S3/R2 via the StorageProvider; only metadata here).
-- Columns on existing RLS-covered tables — no new RLS file.

ALTER TABLE "assessment" ADD COLUMN "fileUploadEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "submission" ADD COLUMN "fileKey" TEXT;
ALTER TABLE "submission" ADD COLUMN "fileName" TEXT;
ALTER TABLE "submission" ADD COLUMN "fileUploaded" BOOLEAN NOT NULL DEFAULT false;

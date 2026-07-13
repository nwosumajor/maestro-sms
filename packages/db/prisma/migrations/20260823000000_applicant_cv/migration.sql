-- Careers: optional CV (PDF) on an applicant — storage key + original name.
ALTER TABLE "applicant" ADD COLUMN "cvKey" TEXT;
ALTER TABLE "applicant" ADD COLUMN "cvName" TEXT;

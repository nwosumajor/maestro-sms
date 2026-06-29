-- Parent enrolment: comprehensive intake + on-application maker-checker review
-- (School admin → HR → Principal) + entrance-exam scheduling. Adds columns to the
-- existing (already RLS-covered) admission_application table — no new table, no
-- new RLS file. The existing app-role GRANT (SELECT/INSERT/UPDATE in
-- 17_admissions_rls.sql) covers the new columns.

ALTER TABLE "admission_application" ADD COLUMN "details" JSONB;
ALTER TABLE "admission_application" ADD COLUMN "desiredClass" TEXT;
ALTER TABLE "admission_application" ADD COLUMN "stages" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "admission_application" ADD COLUMN "currentStage" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "admission_application" ADD COLUMN "approvals" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "admission_application" ADD COLUMN "examDate" TIMESTAMP(3);
ALTER TABLE "admission_application" ADD COLUMN "examNote" TEXT;

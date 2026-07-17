-- Scholarship chain: student-initiated applications flow through class
-- supervisor -> guardian (consent) -> principal before reaching the platform
-- queue; programs gain a category + qualification-exam details; QUALIFIED marks
-- exam candidates.

CREATE TYPE "ScholarshipCategory" AS ENUM ('GENERAL_SCIENCE', 'ART', 'COMMUNITY_DEVELOPMENT', 'MATHEMATICS', 'SPECIAL');
CREATE TYPE "ScholarshipExamMode" AS ENUM ('ONLINE_CBT', 'GAMES', 'PHYSICAL');

ALTER TYPE "ScholarshipApplicationStatus" ADD VALUE 'PENDING_SUPERVISOR';
ALTER TYPE "ScholarshipApplicationStatus" ADD VALUE 'PENDING_PARENT';
ALTER TYPE "ScholarshipApplicationStatus" ADD VALUE 'PENDING_PRINCIPAL';
ALTER TYPE "ScholarshipApplicationStatus" ADD VALUE 'QUALIFIED';

ALTER TABLE "scholarship_program" ADD COLUMN "category" "ScholarshipCategory" NOT NULL DEFAULT 'SPECIAL';
ALTER TABLE "scholarship_program" ADD COLUMN "examMode" "ScholarshipExamMode";
ALTER TABLE "scholarship_program" ADD COLUMN "examAt" TIMESTAMP(3);
ALTER TABLE "scholarship_program" ADD COLUMN "examVenue" TEXT;

ALTER TABLE "scholarship_application" ADD COLUMN "supervisorById" UUID;
ALTER TABLE "scholarship_application" ADD COLUMN "supervisorAt" TIMESTAMP(3);
ALTER TABLE "scholarship_application" ADD COLUMN "supervisorNote" TEXT;
ALTER TABLE "scholarship_application" ADD COLUMN "parentNote" TEXT;
ALTER TABLE "scholarship_application" ADD COLUMN "principalById" UUID;
ALTER TABLE "scholarship_application" ADD COLUMN "principalAt" TIMESTAMP(3);
ALTER TABLE "scholarship_application" ADD COLUMN "principalNote" TEXT;
ALTER TABLE "scholarship_application" ADD COLUMN "rejectedStage" TEXT;

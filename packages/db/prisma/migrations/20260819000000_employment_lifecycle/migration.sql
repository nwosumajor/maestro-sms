-- Contract & confirmation lifecycle: probation/confirmation + grade level on the
-- employee, contract-expiry reminder stamp, and the maker-checker
-- employment_change_request history table. RLS in rls/61.
ALTER TABLE "employee" ADD COLUMN "confirmationStatus" TEXT NOT NULL DEFAULT 'CONFIRMED';
ALTER TABLE "employee" ADD COLUMN "probationEndsAt" DATE;
ALTER TABLE "employee" ADD COLUMN "gradeLevel" TEXT;
ALTER TABLE "employee" ADD COLUMN "contractReminderSentAt" TIMESTAMP(3);

CREATE TABLE "employment_change_request" (
  "id"            UUID NOT NULL,
  "schoolId"      UUID NOT NULL,
  "userId"        UUID NOT NULL,
  "type"          TEXT NOT NULL,
  "newJobTitle"   TEXT,
  "newGradeLevel" TEXT,
  "newEndDate"    DATE,
  "reason"        TEXT,
  "status"        TEXT NOT NULL DEFAULT 'PENDING',
  "requestedById" UUID NOT NULL,
  "decidedById"   UUID,
  "decidedAt"     TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "employment_change_request_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "employment_change_request_schoolId_idx" ON "employment_change_request"("schoolId");
CREATE INDEX "employment_change_request_schoolId_userId_idx" ON "employment_change_request"("schoolId","userId");

-- Public, PRE-TENANT school-onboarding intake. A prospective principal requests
-- (from the public website) to onboard their school; a super_admin reviews it in
-- the operator console and provisions the real tenant on approval. GLOBAL table
-- (no schoolId, RLS-exempt like school/role); grants in
-- prisma/rls/30_onboarding_request_rls.sql (applied separately — the shadow DB
-- rejects the major_user GRANT, so it cannot live in this migration).

-- CreateEnum
CREATE TYPE "OnboardingRequestStatus" AS ENUM ('NEW', 'REVIEWING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "onboarding_request" (
    "id" UUID NOT NULL,
    "schoolName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "desiredSlug" TEXT,
    "notes" TEXT,
    "status" "OnboardingRequestStatus" NOT NULL DEFAULT 'NEW',
    "reviewedById" UUID,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "onboarding_request_status_idx" ON "onboarding_request"("status");

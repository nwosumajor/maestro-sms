-- Referral program: per-school shareable code + append-only conversion ledger
-- (both owned by the REFERRER school; RLS in rls/70_referral_rls.sql), plus the
-- referral linkage on the referred school's subscription and the raw code on
-- the public onboarding request.

CREATE TABLE "school_referral_code" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_referral_code_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "school_referral_conversion" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "referredSchoolId" UUID NOT NULL,
    "referredSchoolName" TEXT NOT NULL,
    "rewardMonths" INTEGER NOT NULL,
    "newPeriodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "school_referral_conversion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "school_referral_code_schoolId_key" ON "school_referral_code"("schoolId");
CREATE UNIQUE INDEX "school_referral_code_code_key" ON "school_referral_code"("code");
CREATE UNIQUE INDEX "school_referral_conversion_referredSchoolId_key" ON "school_referral_conversion"("referredSchoolId");
CREATE INDEX "school_referral_conversion_schoolId_idx" ON "school_referral_conversion"("schoolId");

ALTER TABLE "school_referral_code" ADD CONSTRAINT "school_referral_code_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "school_referral_conversion" ADD CONSTRAINT "school_referral_conversion_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "school_subscription" ADD COLUMN "referredBySchoolId" UUID;
ALTER TABLE "school_subscription" ADD COLUMN "referralRewardAt" TIMESTAMP(3);
ALTER TABLE "onboarding_request" ADD COLUMN "referralCode" TEXT;

-- Growth levers: promo codes (percent off the first charge) + agent/reseller
-- registry with an append-only commission ledger. Global platform tables
-- (posture in rls/72_growth_rls.sql), plus attribution columns.

CREATE TABLE "promo_code" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "percentOff" INTEGER NOT NULL,
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "promo_code_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "promo_code_code_key" ON "promo_code"("code");

CREATE TABLE "agent" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "commissionBp" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_code_key" ON "agent"("code");

CREATE TABLE "agent_commission" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "paymentRef" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" TEXT NOT NULL DEFAULT 'ACCRUED',
    "paidOutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_commission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_commission_schoolId_key" ON "agent_commission"("schoolId");
CREATE INDEX "agent_commission_agentId_idx" ON "agent_commission"("agentId");
ALTER TABLE "agent_commission" ADD CONSTRAINT "agent_commission_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "school_subscription" ADD COLUMN "agentId" UUID;
ALTER TABLE "platform_subscription_payment" ADD COLUMN "promoCode" TEXT;
ALTER TABLE "onboarding_request" ADD COLUMN "agentCode" TEXT;

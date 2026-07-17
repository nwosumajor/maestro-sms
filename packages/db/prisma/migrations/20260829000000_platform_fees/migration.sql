-- Platform take-rate on online fee collection: global fee config (RLS posture in
-- rls/71_platform_fee_rls.sql), per-school bearer override on the school
-- registry, and the fee record on each online payment row.

CREATE TABLE "platform_fee_config" (
    "id" TEXT NOT NULL,
    "flatMinor" INTEGER NOT NULL DEFAULT 0,
    "percentBp" INTEGER NOT NULL DEFAULT 0,
    "capMinor" INTEGER,
    "bearer" TEXT NOT NULL DEFAULT 'PARENT',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_fee_config_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "school" ADD COLUMN "paymentFeeBearer" TEXT;
ALTER TABLE "payment" ADD COLUMN "platformFeeMinor" INTEGER NOT NULL DEFAULT 0;

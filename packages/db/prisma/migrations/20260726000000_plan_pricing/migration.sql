-- GLOBAL plan-tier pricing overrides (operator-set). RLS-exempt like school/role;
-- grants + the read policy live in prisma/rls/46_plan_pricing_rls.sql (grants
-- cannot live here — Prisma's shadow DB rejects the app-role GRANT).
CREATE TABLE "plan_price" (
    "plan" TEXT NOT NULL,
    "perSeatMonthlyMinor" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_price_pkey" PRIMARY KEY ("plan")
);

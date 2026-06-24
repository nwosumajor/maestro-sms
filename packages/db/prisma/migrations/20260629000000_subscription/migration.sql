-- Per-school subscription plan + module overrides (platform billing layer).
-- Tenant-scoped (one row per school); RLS in 22_subscription_rls.sql (applied
-- separately). super_admin manages it via the Operator Console (`platform.operate`);
-- the ModuleGuard reads the effective module set to gate routes, and the web nav
-- hides disabled modules. A school with no row defaults to ENTERPRISE in the app.
CREATE TABLE "school_subscription" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'ENTERPRISE',
    "overrides" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "school_subscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "school_subscription_schoolId_key" ON "school_subscription"("schoolId");

ALTER TABLE "school_subscription" ADD CONSTRAINT "school_subscription_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

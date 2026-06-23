-- Security: Just-In-Time privilege elevation / break-glass grants.
-- The audit VIEWER reads the existing audit_log; no table needed for it.
-- RLS applied SEPARATELY in prisma/rls/13_security_rls.sql.

-- CreateEnum
CREATE TYPE "GrantStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "privilege_grant" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "permission" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "GrantStatus" NOT NULL DEFAULT 'PENDING',
    "breakGlass" BOOLEAN NOT NULL DEFAULT false,
    "requestedById" UUID NOT NULL,
    "approvedById" UUID,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "privilege_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "privilege_grant_schoolId_idx" ON "privilege_grant"("schoolId");
CREATE INDEX "privilege_grant_schoolId_userId_status_idx" ON "privilege_grant"("schoolId", "userId", "status");

-- AddForeignKey
ALTER TABLE "privilege_grant" ADD CONSTRAINT "privilege_grant_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "privilege_grant" ADD CONSTRAINT "privilege_grant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

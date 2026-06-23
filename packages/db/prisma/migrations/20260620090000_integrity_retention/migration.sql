-- Integrity retention/purge: per-school window on the registry + an immutable
-- per-run audit table. RLS for the new table is applied SEPARATELY in
-- prisma/rls/06_integrity_retention_rls.sql (NOT in this Prisma migration).

-- AlterTable: per-school NDPR retention window (days) for integrity telemetry.
ALTER TABLE "school" ADD COLUMN "integrityRetentionDays" INTEGER NOT NULL DEFAULT 365;

-- CreateTable: immutable record of each retention/purge run, per school.
CREATE TABLE "integrity_retention_run" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "retentionDays" INTEGER NOT NULL,
    "cutoff" TIMESTAMP(3) NOT NULL,
    "signalsDeleted" INTEGER NOT NULL,
    "draftsDeleted" INTEGER NOT NULL,
    "telemetryDeleted" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrity_retention_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integrity_retention_run_schoolId_idx" ON "integrity_retention_run"("schoolId");

-- CreateIndex
CREATE INDEX "integrity_retention_run_schoolId_createdAt_idx" ON "integrity_retention_run"("schoolId", "createdAt");

-- AddForeignKey
ALTER TABLE "integrity_retention_run" ADD CONSTRAINT "integrity_retention_run_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

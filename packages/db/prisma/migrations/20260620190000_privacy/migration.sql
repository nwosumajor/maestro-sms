-- Privacy / NDPR: right-to-erasure requests. RLS in prisma/rls/14_privacy_rls.sql.

-- CreateEnum
CREATE TYPE "ErasureStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "erasure_request" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ErasureStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" UUID,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "erasure_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "erasure_request_schoolId_idx" ON "erasure_request"("schoolId");
CREATE INDEX "erasure_request_schoolId_status_idx" ON "erasure_request"("schoolId", "status");

-- AddForeignKey
ALTER TABLE "erasure_request" ADD CONSTRAINT "erasure_request_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "erasure_request" ADD CONSTRAINT "erasure_request_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

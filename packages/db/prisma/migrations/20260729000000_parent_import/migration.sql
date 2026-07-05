-- CreateTable
CREATE TABLE "parent_import_batch" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PENDING',
    "uploadedById" UUID NOT NULL,
    "reviewedById" UUID,
    "rows" JSONB NOT NULL,
    "summary" JSONB,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parent_import_batch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "parent_import_batch_schoolId_idx" ON "parent_import_batch"("schoolId");

-- CreateIndex
CREATE INDEX "parent_import_batch_schoolId_status_idx" ON "parent_import_batch"("schoolId", "status");

-- AddForeignKey
ALTER TABLE "parent_import_batch" ADD CONSTRAINT "parent_import_batch_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

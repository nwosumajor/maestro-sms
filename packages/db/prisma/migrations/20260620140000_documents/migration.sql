-- Document Vault: file METADATA only (bytes live in S3/R2 via presigned URLs).
-- RLS applied SEPARATELY in prisma/rls/11_documents_rls.sql.

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('REPORT_CARD', 'RECEIPT', 'CERTIFICATE', 'TRANSCRIPT', 'OTHER');
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'UPLOADED');

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID,
    "type" "DocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "uploadedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_storageKey_key" ON "document"("storageKey");
CREATE INDEX "document_schoolId_idx" ON "document"("schoolId");
CREATE INDEX "document_schoolId_studentId_idx" ON "document"("schoolId", "studentId");
CREATE INDEX "document_schoolId_type_idx" ON "document"("schoolId", "type");

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document" ADD CONSTRAINT "document_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document" ADD CONSTRAINT "document_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

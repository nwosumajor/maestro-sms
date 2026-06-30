-- Certificate / ID-card issuance log (append-only). Tenant-scoped. RLS in prisma/rls/43.
CREATE TABLE "issued_certificate" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "subjectId" UUID NOT NULL,
  "title" TEXT,
  "body" TEXT,
  "issuedById" UUID NOT NULL,
  "serial" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "issued_certificate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "issued_certificate_schoolId_idx" ON "issued_certificate"("schoolId");
CREATE INDEX "issued_certificate_schoolId_subjectId_idx" ON "issued_certificate"("schoolId", "subjectId");

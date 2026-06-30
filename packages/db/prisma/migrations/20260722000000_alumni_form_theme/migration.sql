-- Alumni + Form Builder tables + per-school theme columns on school_branding.
ALTER TABLE "school_branding" ADD COLUMN "brandHue" INTEGER;
ALTER TABLE "school_branding" ADD COLUMN "brandSat" INTEGER;
ALTER TABLE "school_branding" ADD COLUMN "brandLight" INTEGER;
ALTER TABLE "school_branding" ADD COLUMN "fontFamily" TEXT;

CREATE TABLE "alumnus" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "userId" UUID,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "graduationYear" INTEGER,
  "lastClass" TEXT,
  "occupation" TEXT,
  "notes" TEXT,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "alumnus_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "alumnus_schoolId_idx" ON "alumnus"("schoolId");
CREATE INDEX "alumnus_schoolId_graduationYear_idx" ON "alumnus"("schoolId", "graduationYear");

CREATE TABLE "form" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "fields" JSONB NOT NULL DEFAULT '[]',
  "audience" TEXT NOT NULL DEFAULT 'ALL',
  "anonymous" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "form_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "form_schoolId_idx" ON "form"("schoolId");

CREATE TABLE "form_response" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "formId" UUID NOT NULL,
  "respondentId" UUID NOT NULL,
  "answers" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "form_response_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "form_response_formId_respondentId_key" ON "form_response"("formId", "respondentId");
CREATE INDEX "form_response_schoolId_idx" ON "form_response"("schoolId");
CREATE INDEX "form_response_schoolId_formId_idx" ON "form_response"("schoolId", "formId");

ALTER TABLE "form_response" ADD CONSTRAINT "form_response_formId_fkey"
  FOREIGN KEY ("formId") REFERENCES "form"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

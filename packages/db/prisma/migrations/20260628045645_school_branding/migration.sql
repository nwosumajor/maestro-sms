-- CreateTable
CREATE TABLE "school_branding" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "logoKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_branding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "school_branding_schoolId_key" ON "school_branding"("schoolId");

-- CreateIndex
CREATE INDEX "school_branding_schoolId_idx" ON "school_branding"("schoolId");


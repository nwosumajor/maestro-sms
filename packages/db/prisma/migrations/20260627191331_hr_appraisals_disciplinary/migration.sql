-- CreateTable
CREATE TABLE "appraisal" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "reviewerId" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "overallRating" INTEGER,
    "summary" TEXT,
    "goals" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appraisal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disciplinary_case" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'LOW',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disciplinary_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disciplinary_entry" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "note" TEXT NOT NULL,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disciplinary_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appraisal_schoolId_idx" ON "appraisal"("schoolId");

-- CreateIndex
CREATE INDEX "appraisal_schoolId_userId_idx" ON "appraisal"("schoolId", "userId");

-- CreateIndex
CREATE INDEX "disciplinary_case_schoolId_idx" ON "disciplinary_case"("schoolId");

-- CreateIndex
CREATE INDEX "disciplinary_case_schoolId_userId_idx" ON "disciplinary_case"("schoolId", "userId");

-- CreateIndex
CREATE INDEX "disciplinary_entry_schoolId_idx" ON "disciplinary_entry"("schoolId");

-- CreateIndex
CREATE INDEX "disciplinary_entry_schoolId_caseId_idx" ON "disciplinary_entry"("schoolId", "caseId");


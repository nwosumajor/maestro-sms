-- CreateTable
CREATE TABLE "staff_checklist" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_checklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_checklist_item" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "checklistId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneById" UUID,
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "staff_checklist_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_document" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "documentId" UUID,
    "expiresAt" DATE,
    "reminderSentAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_record" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "provider" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "completedAt" DATE,
    "expiresAt" DATE,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_checklist_schoolId_idx" ON "staff_checklist"("schoolId");

-- CreateIndex
CREATE INDEX "staff_checklist_schoolId_userId_idx" ON "staff_checklist"("schoolId", "userId");

-- CreateIndex
CREATE INDEX "staff_checklist_item_schoolId_idx" ON "staff_checklist_item"("schoolId");

-- CreateIndex
CREATE INDEX "staff_checklist_item_schoolId_checklistId_idx" ON "staff_checklist_item"("schoolId", "checklistId");

-- CreateIndex
CREATE INDEX "staff_document_schoolId_idx" ON "staff_document"("schoolId");

-- CreateIndex
CREATE INDEX "staff_document_schoolId_userId_idx" ON "staff_document"("schoolId", "userId");

-- CreateIndex
CREATE INDEX "training_record_schoolId_idx" ON "training_record"("schoolId");

-- CreateIndex
CREATE INDEX "training_record_schoolId_userId_idx" ON "training_record"("schoolId", "userId");


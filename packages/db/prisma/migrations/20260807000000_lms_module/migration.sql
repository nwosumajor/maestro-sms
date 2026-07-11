-- LMS modules (units grouping a class's content into an ordered learning path). Tenant-scoped.
-- CreateTable
CREATE TABLE "lms_module" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lms_module_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lms_module_schoolId_idx" ON "lms_module"("schoolId");
CREATE INDEX "lms_module_schoolId_classId_idx" ON "lms_module"("schoolId", "classId");

-- Group content into modules (nullable = ungrouped).
ALTER TABLE "lms_content" ADD COLUMN "moduleId" UUID;

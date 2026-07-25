-- CreateTable
CREATE TABLE "exam_schedule" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "termId" UUID,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exam_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exam_schedule_schoolId_idx" ON "exam_schedule"("schoolId");
CREATE INDEX "exam_schedule_schoolId_status_idx" ON "exam_schedule"("schoolId", "status");

-- AlterTable exam_sitting
ALTER TABLE "exam_sitting" ADD COLUMN "scheduleId" UUID;
ALTER TABLE "exam_sitting" ADD COLUMN "cbtExamId" UUID;
CREATE INDEX "exam_sitting_schoolId_scheduleId_idx" ON "exam_sitting"("schoolId", "scheduleId");
ALTER TABLE "exam_sitting" ADD CONSTRAINT "exam_sitting_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "exam_schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable cbt_exam
ALTER TABLE "cbt_exam" ADD COLUMN "releasedAt" TIMESTAMP(3);
ALTER TABLE "cbt_exam" ADD COLUMN "releasedById" UUID;

-- AddForeignKey exam_schedule -> school
ALTER TABLE "exam_schedule" ADD CONSTRAINT "exam_schedule_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

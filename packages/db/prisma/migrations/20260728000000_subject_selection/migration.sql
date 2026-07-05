-- CreateTable
CREATE TABLE "subject_selection" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "subjectIds" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_SUPERVISOR',
    "supervisorId" UUID,
    "supervisorActedById" UUID,
    "reviewedById" UUID,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subject_selection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subject_selection_schoolId_idx" ON "subject_selection"("schoolId");

-- CreateIndex
CREATE INDEX "subject_selection_schoolId_classId_termId_status_idx" ON "subject_selection"("schoolId", "classId", "termId", "status");

-- CreateIndex
CREATE INDEX "subject_selection_schoolId_supervisorId_status_idx" ON "subject_selection"("schoolId", "supervisorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "subject_selection_termId_studentId_key" ON "subject_selection"("termId", "studentId");

-- AddForeignKey
ALTER TABLE "subject_selection" ADD CONSTRAINT "subject_selection_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

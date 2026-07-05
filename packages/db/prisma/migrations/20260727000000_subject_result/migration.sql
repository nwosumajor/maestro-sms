-- CreateTable
CREATE TABLE "subject_result" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "exam" DOUBLE PRECISION,
    "midterm" DOUBLE PRECISION,
    "assignment" DOUBLE PRECISION,
    "classNote" DOUBLE PRECISION,
    "total" DOUBLE PRECISION,
    "grade" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "gradedById" UUID,
    "gradedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subject_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subject_result_schoolId_idx" ON "subject_result"("schoolId");

-- CreateIndex
CREATE INDEX "subject_result_schoolId_classId_subjectId_termId_idx" ON "subject_result"("schoolId", "classId", "subjectId", "termId");

-- CreateIndex
CREATE INDEX "subject_result_schoolId_studentId_sessionId_idx" ON "subject_result"("schoolId", "studentId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "subject_result_sessionId_termId_subjectId_studentId_key" ON "subject_result"("sessionId", "termId", "subjectId", "studentId");

-- AddForeignKey
ALTER TABLE "subject_result" ADD CONSTRAINT "subject_result_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

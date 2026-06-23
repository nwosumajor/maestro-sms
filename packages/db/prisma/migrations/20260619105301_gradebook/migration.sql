-- CreateTable
CREATE TABLE "grade" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "maxScore" DOUBLE PRECISION NOT NULL,
    "feedback" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "gradedById" UUID NOT NULL,
    "gradedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "grade_submissionId_key" ON "grade"("submissionId");

-- CreateIndex
CREATE INDEX "grade_schoolId_idx" ON "grade"("schoolId");

-- CreateIndex
CREATE INDEX "grade_schoolId_submissionId_idx" ON "grade"("schoolId", "submissionId");

-- AddForeignKey
ALTER TABLE "grade" ADD CONSTRAINT "grade_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade" ADD CONSTRAINT "grade_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade" ADD CONSTRAINT "grade_gradedById_fkey" FOREIGN KEY ("gradedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

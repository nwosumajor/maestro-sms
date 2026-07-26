-- CreateTable
CREATE TABLE "platform_feedback" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "reviewedById" UUID,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_feedback_schoolId_idx" ON "platform_feedback"("schoolId");
CREATE INDEX "platform_feedback_schoolId_createdAt_idx" ON "platform_feedback"("schoolId", "createdAt");

-- AddForeignKey
ALTER TABLE "platform_feedback" ADD CONSTRAINT "platform_feedback_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- End-of-session promotion with maker-checker. A staged batch moves a class's
-- students into its next class only after school_admin approval. New tenant table
-- (promotion_batch) — RLS + grants in prisma/rls/33_promotion_rls.sql (applied
-- separately).

-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "promotion_batch" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "sourceClassId" UUID NOT NULL,
    "targetClassId" UUID,
    "studentIds" JSONB NOT NULL,
    "status" "PromotionStatus" NOT NULL DEFAULT 'PENDING',
    "initiatedById" UUID NOT NULL,
    "reviewedById" UUID,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotion_batch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "promotion_batch_schoolId_idx" ON "promotion_batch"("schoolId");
CREATE INDEX "promotion_batch_schoolId_status_idx" ON "promotion_batch"("schoolId", "status");
ALTER TABLE "promotion_batch" ADD CONSTRAINT "promotion_batch_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "promotion_batch" ADD CONSTRAINT "promotion_batch_sourceClassId_fkey"
  FOREIGN KEY ("sourceClassId") REFERENCES "class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "promotion_batch" ADD CONSTRAINT "promotion_batch_targetClassId_fkey"
  FOREIGN KEY ("targetClassId") REFERENCES "class"("id") ON DELETE SET NULL ON UPDATE CASCADE;

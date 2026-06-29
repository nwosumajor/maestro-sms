-- Student-lifecycle enhancements:
--  (1) Class.capacity — enrollment/import/promotion refuse to exceed it.
--  (2) Enrollment.statusReason — transfer/withdrawal lifecycle context.
--  (3) Academic calendar — academic_session + term (makes "third term" first-class).
--  (4) PromotionBatch.termId — stamp the term a promotion runs at the end of.
-- New tenant tables (academic_session, term) — RLS + grants in
-- prisma/rls/34_academic_rls.sql (applied separately).

ALTER TABLE "class" ADD COLUMN "capacity" INTEGER;
ALTER TABLE "enrollment" ADD COLUMN "statusReason" TEXT;

-- CreateTable academic_session
CREATE TABLE "academic_session" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "startDate" DATE,
    "endDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academic_session_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "academic_session_schoolId_idx" ON "academic_session"("schoolId");
ALTER TABLE "academic_session" ADD CONSTRAINT "academic_session_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable term
CREATE TABLE "term" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "startDate" DATE,
    "endDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "term_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "term_schoolId_idx" ON "term"("schoolId");
CREATE INDEX "term_schoolId_sessionId_idx" ON "term"("schoolId", "sessionId");
ALTER TABLE "term" ADD CONSTRAINT "term_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "term" ADD CONSTRAINT "term_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "academic_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PromotionBatch.termId (scalar ref to term)
ALTER TABLE "promotion_batch" ADD COLUMN "termId" UUID;
ALTER TABLE "promotion_batch" ADD CONSTRAINT "promotion_batch_termId_fkey"
  FOREIGN KEY ("termId") REFERENCES "term"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Behavioural / psychomotor trait ratings: one row per pupil, term and trait.
-- The trait catalogue lives in @sms/types, not in an enum here, so a school that
-- renames or adds a trait needs no migration.
CREATE TABLE "student_trait_rating" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "traitKey" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "ratedById" UUID,
    "ratedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "student_trait_rating_pkey" PRIMARY KEY ("id")
);

-- One rating per pupil per trait per term; re-rating updates in place.
CREATE UNIQUE INDEX "student_trait_rating_studentId_termId_traitKey_key"
    ON "student_trait_rating"("studentId", "termId", "traitKey");
CREATE INDEX "student_trait_rating_schoolId_idx" ON "student_trait_rating"("schoolId");
CREATE INDEX "student_trait_rating_schoolId_termId_idx" ON "student_trait_rating"("schoolId", "termId");

-- Golden Rule #1: every tenant table FKs to school.
ALTER TABLE "student_trait_rating" ADD CONSTRAINT "student_trait_rating_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_trait_rating" ADD CONSTRAINT "student_trait_rating_termId_fkey"
    FOREIGN KEY ("termId") REFERENCES "term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

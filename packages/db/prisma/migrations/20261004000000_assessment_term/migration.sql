-- Assessment.termId — tag an assessment to a term so its graded submissions can
-- be scoped to a term on the report card. Nullable; existing rows read all-time.
ALTER TABLE "assessment" ADD COLUMN "termId" UUID;
CREATE INDEX "assessment_schoolId_termId_idx" ON "assessment" ("schoolId", "termId");
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_termId_fkey" FOREIGN KEY ("termId") REFERENCES "term"("id") ON UPDATE CASCADE ON DELETE SET NULL;

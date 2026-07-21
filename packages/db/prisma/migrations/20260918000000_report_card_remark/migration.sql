-- Per-student, per-term report-card remarks (class teacher + head).

CREATE TABLE "report_card_remark" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "classTeacherRemark" TEXT,
    "classTeacherId" UUID,
    "headRemark" TEXT,
    "headId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_card_remark_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "report_card_remark_studentId_termId_key" ON "report_card_remark"("studentId", "termId");
CREATE INDEX "report_card_remark_schoolId_idx" ON "report_card_remark"("schoolId");
CREATE INDEX "report_card_remark_schoolId_termId_idx" ON "report_card_remark"("schoolId", "termId");

ALTER TABLE "report_card_remark"
  ADD CONSTRAINT "report_card_remark_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "report_card_remark"
  ADD CONSTRAINT "report_card_remark_termId_fkey"
  FOREIGN KEY ("termId") REFERENCES "term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

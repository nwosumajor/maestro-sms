-- Duty rostering: dated shift assignments for non-timetabled staff. RLS in rls/60.
CREATE TABLE "duty_assignment" (
  "id"           UUID NOT NULL,
  "schoolId"     UUID NOT NULL,
  "userId"       UUID NOT NULL,
  "date"         DATE NOT NULL,
  "title"        TEXT NOT NULL,
  "startTime"    TEXT NOT NULL,
  "endTime"      TEXT NOT NULL,
  "note"         TEXT,
  "assignedById" UUID NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "duty_assignment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "duty_assignment_schoolId_idx" ON "duty_assignment"("schoolId");
CREATE INDEX "duty_assignment_schoolId_date_idx" ON "duty_assignment"("schoolId","date");
CREATE INDEX "duty_assignment_schoolId_userId_idx" ON "duty_assignment"("schoolId","userId");

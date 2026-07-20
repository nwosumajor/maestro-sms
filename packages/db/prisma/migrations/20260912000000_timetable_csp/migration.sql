-- CSP timetable auto-generation inputs.
--   class_subject_teacher.lessonsPerWeek  — per-offering weekly quota (was one
--                                           global knob on the generate call)
--   class_subject_teacher.preferredRoomId — fixed room (e.g. Chemistry -> lab);
--                                           hard no-double-booking constraint
--   teacher_unavailability                — NEW tenant table: slots a teacher
--                                           cannot teach (RLS in rls/77)

ALTER TABLE "class_subject_teacher" ADD COLUMN "lessonsPerWeek" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "class_subject_teacher" ADD COLUMN "preferredRoomId" UUID;
ALTER TABLE "class_subject_teacher"
  ADD CONSTRAINT "class_subject_teacher_preferredRoomId_fkey"
  FOREIGN KEY ("preferredRoomId") REFERENCES "room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "teacher_unavailability" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "dayOfWeek" "DayOfWeek" NOT NULL,
    "periodId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teacher_unavailability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "teacher_unavailability_teacherId_dayOfWeek_periodId_key"
  ON "teacher_unavailability"("teacherId", "dayOfWeek", "periodId");
CREATE INDEX "teacher_unavailability_schoolId_idx" ON "teacher_unavailability"("schoolId");
CREATE INDEX "teacher_unavailability_schoolId_teacherId_idx"
  ON "teacher_unavailability"("schoolId", "teacherId");

ALTER TABLE "teacher_unavailability"
  ADD CONSTRAINT "teacher_unavailability_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "teacher_unavailability"
  ADD CONSTRAINT "teacher_unavailability_periodId_fkey"
  FOREIGN KEY ("periodId") REFERENCES "period"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- DB-level FK to "user" (scalar in Prisma — no relation, keeps User lean).
ALTER TABLE "teacher_unavailability"
  ADD CONSTRAINT "teacher_unavailability_teacherId_fkey"
  FOREIGN KEY ("teacherId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

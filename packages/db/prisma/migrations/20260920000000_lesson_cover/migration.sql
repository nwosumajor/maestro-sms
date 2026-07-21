-- Teacher substitution / cover for a dated occurrence of a weekly lesson.

CREATE TABLE "lesson_cover" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "timetableEntryId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "coveringTeacherId" UUID NOT NULL,
    "note" TEXT,
    "assignedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lesson_cover_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lesson_cover_timetableEntryId_date_key" ON "lesson_cover"("timetableEntryId", "date");
CREATE INDEX "lesson_cover_schoolId_idx" ON "lesson_cover"("schoolId");
CREATE INDEX "lesson_cover_schoolId_date_idx" ON "lesson_cover"("schoolId", "date");
CREATE INDEX "lesson_cover_schoolId_coveringTeacherId_idx" ON "lesson_cover"("schoolId", "coveringTeacherId");

ALTER TABLE "lesson_cover"
  ADD CONSTRAINT "lesson_cover_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lesson_cover"
  ADD CONSTRAINT "lesson_cover_timetableEntryId_fkey"
  FOREIGN KEY ("timetableEntryId") REFERENCES "timetable_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Timetabling: periods (bell schedule) + rooms + weekly lesson grid.
-- RLS applied SEPARATELY in prisma/rls/12_timetable_rls.sql.

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateTable
CREATE TABLE "period" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_entry" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "dayOfWeek" "DayOfWeek" NOT NULL,
    "periodId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "teacherId" UUID NOT NULL,
    "roomId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timetable_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "period_schoolId_sequence_key" ON "period"("schoolId", "sequence");
CREATE INDEX "period_schoolId_idx" ON "period"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "room_schoolId_name_key" ON "room"("schoolId", "name");
CREATE INDEX "room_schoolId_idx" ON "room"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_entry_schoolId_classId_dayOfWeek_periodId_key" ON "timetable_entry"("schoolId", "classId", "dayOfWeek", "periodId");
CREATE INDEX "timetable_entry_schoolId_idx" ON "timetable_entry"("schoolId");
CREATE INDEX "timetable_entry_schoolId_classId_idx" ON "timetable_entry"("schoolId", "classId");
CREATE INDEX "timetable_entry_schoolId_teacherId_dayOfWeek_periodId_idx" ON "timetable_entry"("schoolId", "teacherId", "dayOfWeek", "periodId");
CREATE INDEX "timetable_entry_schoolId_roomId_dayOfWeek_periodId_idx" ON "timetable_entry"("schoolId", "roomId", "dayOfWeek", "periodId");

-- AddForeignKey (school)
ALTER TABLE "period" ADD CONSTRAINT "period_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "room" ADD CONSTRAINT "room_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "timetable_entry" ADD CONSTRAINT "timetable_entry_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (intra-module)
ALTER TABLE "timetable_entry" ADD CONSTRAINT "timetable_entry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "timetable_entry" ADD CONSTRAINT "timetable_entry_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey (class / teacher — DB FK only, no Prisma relation)
ALTER TABLE "timetable_entry" ADD CONSTRAINT "timetable_entry_classId_fkey" FOREIGN KEY ("classId") REFERENCES "class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "timetable_entry" ADD CONSTRAINT "timetable_entry_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

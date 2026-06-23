-- Attendance: per-class daily register (session) + per-student records.
-- RLS applied SEPARATELY in prisma/rls/08_attendance_rls.sql.

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED');

-- CreateTable
CREATE TABLE "attendance_session" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "takenById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_record" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_session_classId_date_key" ON "attendance_session"("classId", "date");
CREATE INDEX "attendance_session_schoolId_idx" ON "attendance_session"("schoolId");
CREATE INDEX "attendance_session_schoolId_classId_idx" ON "attendance_session"("schoolId", "classId");
CREATE INDEX "attendance_session_schoolId_date_idx" ON "attendance_session"("schoolId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_record_sessionId_studentId_key" ON "attendance_record"("sessionId", "studentId");
CREATE INDEX "attendance_record_schoolId_idx" ON "attendance_record"("schoolId");
CREATE INDEX "attendance_record_schoolId_sessionId_idx" ON "attendance_record"("schoolId", "sessionId");
CREATE INDEX "attendance_record_schoolId_studentId_idx" ON "attendance_record"("schoolId", "studentId");

-- AddForeignKey
ALTER TABLE "attendance_session" ADD CONSTRAINT "attendance_session_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_session" ADD CONSTRAINT "attendance_session_classId_fkey" FOREIGN KEY ("classId") REFERENCES "class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_session" ADD CONSTRAINT "attendance_session_takenById_fkey" FOREIGN KEY ("takenById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_record" ADD CONSTRAINT "attendance_record_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_record" ADD CONSTRAINT "attendance_record_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "attendance_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attendance_record" ADD CONSTRAINT "attendance_record_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

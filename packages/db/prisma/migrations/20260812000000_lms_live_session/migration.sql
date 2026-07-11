-- Live/virtual classroom: scheduled sessions (Zoom/Meet/Jitsi) + a per-student
-- join register. Both tenant-scoped; RLS in rls/55.
CREATE TABLE "lms_live_session" (
  "id"              UUID NOT NULL,
  "schoolId"        UUID NOT NULL,
  "classId"         UUID NOT NULL,
  "title"           TEXT NOT NULL,
  "provider"        TEXT NOT NULL,
  "joinUrl"         TEXT NOT NULL,
  "startsAt"        TIMESTAMP(3) NOT NULL,
  "durationMinutes" INTEGER NOT NULL DEFAULT 60,
  "status"          TEXT NOT NULL DEFAULT 'SCHEDULED',
  "hostId"          UUID NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lms_live_session_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lms_live_session_schoolId_idx" ON "lms_live_session"("schoolId");
CREATE INDEX "lms_live_session_schoolId_classId_idx" ON "lms_live_session"("schoolId","classId");

CREATE TABLE "lms_live_attendance" (
  "id"        UUID NOT NULL,
  "schoolId"  UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "studentId" UUID NOT NULL,
  "joinedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lms_live_attendance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lms_live_attendance_sessionId_studentId_key" ON "lms_live_attendance"("sessionId","studentId");
CREATE INDEX "lms_live_attendance_schoolId_idx" ON "lms_live_attendance"("schoolId");
CREATE INDEX "lms_live_attendance_schoolId_sessionId_idx" ON "lms_live_attendance"("schoolId","sessionId");

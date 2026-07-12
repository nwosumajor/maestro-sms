-- Staff attendance (unified across ADMIN / SELF_KIOSK / BIOMETRIC capture) +
-- the per-school TOTP clock-in kiosk config. RLS in rls/59.
CREATE TABLE "staff_attendance" (
  "id"         UUID NOT NULL,
  "schoolId"   UUID NOT NULL,
  "userId"     UUID NOT NULL,
  "date"       DATE NOT NULL,
  "status"     TEXT NOT NULL,
  "source"     TEXT NOT NULL,
  "markedById" UUID NOT NULL,
  "clockInAt"  TIMESTAMP(3),
  "ip"         TEXT,
  "flagged"    BOOLEAN NOT NULL DEFAULT false,
  "note"       TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "staff_attendance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "staff_attendance_userId_date_key" ON "staff_attendance"("userId","date");
CREATE INDEX "staff_attendance_schoolId_idx" ON "staff_attendance"("schoolId");
CREATE INDEX "staff_attendance_schoolId_date_idx" ON "staff_attendance"("schoolId","date");

CREATE TABLE "attendance_kiosk" (
  "id"          UUID NOT NULL,
  "schoolId"    UUID NOT NULL,
  "enabled"     BOOLEAN NOT NULL DEFAULT false,
  "secretEnc"   TEXT NOT NULL,
  "allowedIps"  TEXT,
  "windowStart" TEXT NOT NULL DEFAULT '06:00',
  "windowEnd"   TEXT NOT NULL DEFAULT '10:00',
  "lateAfter"   TEXT NOT NULL DEFAULT '08:00',
  "updatedById" UUID NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "attendance_kiosk_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "attendance_kiosk_schoolId_key" ON "attendance_kiosk"("schoolId");

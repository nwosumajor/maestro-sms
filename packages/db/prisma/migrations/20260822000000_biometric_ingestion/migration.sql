-- Biometric terminal ingestion: device registry (HMAC secrets, encrypted) +
-- device-user-code -> staff mapping. Events land in staff_attendance with
-- source BIOMETRIC. Templates never enter the system. RLS in rls/63.
CREATE TABLE "attendance_device" (
  "id"          UUID NOT NULL,
  "schoolId"    UUID NOT NULL,
  "name"        TEXT NOT NULL,
  "deviceId"    TEXT NOT NULL,
  "secretEnc"   TEXT NOT NULL,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "lastSeenAt"  TIMESTAMP(3),
  "createdById" UUID NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "attendance_device_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "attendance_device_schoolId_deviceId_key" ON "attendance_device"("schoolId","deviceId");
CREATE INDEX "attendance_device_schoolId_idx" ON "attendance_device"("schoolId");

CREATE TABLE "biometric_enrollment" (
  "id"           UUID NOT NULL,
  "schoolId"     UUID NOT NULL,
  "deviceUserId" TEXT NOT NULL,
  "userId"       UUID NOT NULL,
  "createdById"  UUID NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "biometric_enrollment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "biometric_enrollment_schoolId_deviceUserId_key" ON "biometric_enrollment"("schoolId","deviceUserId");
CREATE INDEX "biometric_enrollment_schoolId_idx" ON "biometric_enrollment"("schoolId");

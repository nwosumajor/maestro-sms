-- Per-user external-channel notification preferences.

CREATE TABLE "notification_preference" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT true,
    "mutedTypes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_preference_userId_key" ON "notification_preference"("userId");
CREATE INDEX "notification_preference_schoolId_idx" ON "notification_preference"("schoolId");

ALTER TABLE "notification_preference"
  ADD CONSTRAINT "notification_preference_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Parent-teacher meeting slots + bookings.

CREATE TABLE "meeting_slot" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "location" TEXT,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "meeting_slot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "meeting_slot_schoolId_idx" ON "meeting_slot"("schoolId");
CREATE INDEX "meeting_slot_schoolId_teacherId_idx" ON "meeting_slot"("schoolId", "teacherId");
CREATE INDEX "meeting_slot_schoolId_startsAt_idx" ON "meeting_slot"("schoolId", "startsAt");
ALTER TABLE "meeting_slot" ADD CONSTRAINT "meeting_slot_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "meeting_booking" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "slotId" UUID NOT NULL,
    "parentId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BOOKED',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "meeting_booking_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "meeting_booking_schoolId_idx" ON "meeting_booking"("schoolId");
CREATE INDEX "meeting_booking_schoolId_slotId_idx" ON "meeting_booking"("schoolId", "slotId");
CREATE INDEX "meeting_booking_schoolId_parentId_idx" ON "meeting_booking"("schoolId", "parentId");
ALTER TABLE "meeting_booking" ADD CONSTRAINT "meeting_booking_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "meeting_booking" ADD CONSTRAINT "meeting_booking_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "meeting_slot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

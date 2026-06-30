-- Hostel Management: hostels, rooms (rent + custom fields), student allocations.
-- Tenant-scoped (school_id non-null). RLS applied separately (prisma/rls/36).
CREATE TABLE "hostel" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'MIXED',
  "wardenId" UUID,
  "customFields" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hostel_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "hostel_schoolId_idx" ON "hostel"("schoolId");

CREATE TABLE "hostel_room" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "hostelId" UUID NOT NULL,
  "roomNumber" TEXT NOT NULL,
  "roomType" TEXT NOT NULL DEFAULT 'SHARED',
  "capacity" INTEGER NOT NULL DEFAULT 1,
  "rentMinor" INTEGER NOT NULL DEFAULT 0,
  "customFields" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hostel_room_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "hostel_room_hostelId_roomNumber_key" ON "hostel_room"("hostelId", "roomNumber");
CREATE INDEX "hostel_room_schoolId_idx" ON "hostel_room"("schoolId");
CREATE INDEX "hostel_room_schoolId_hostelId_idx" ON "hostel_room"("schoolId", "hostelId");

CREATE TABLE "hostel_allocation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "studentId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "allocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "vacatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hostel_allocation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "hostel_allocation_schoolId_idx" ON "hostel_allocation"("schoolId");
CREATE INDEX "hostel_allocation_schoolId_studentId_idx" ON "hostel_allocation"("schoolId", "studentId");
CREATE INDEX "hostel_allocation_roomId_status_idx" ON "hostel_allocation"("roomId", "status");

ALTER TABLE "hostel_room" ADD CONSTRAINT "hostel_room_hostelId_fkey"
  FOREIGN KEY ("hostelId") REFERENCES "hostel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hostel_allocation" ADD CONSTRAINT "hostel_allocation_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "hostel_room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

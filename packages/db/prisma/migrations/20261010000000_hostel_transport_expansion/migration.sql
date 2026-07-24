-- CreateTable
CREATE TABLE "hostel_attendance" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "hostelId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PRESENT',
    "note" TEXT,
    "takenById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hostel_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hostel_exeat" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "hostelId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "destination" TEXT,
    "departAt" TIMESTAMP(3) NOT NULL,
    "expectedReturnAt" TIMESTAMP(3) NOT NULL,
    "actualReturnAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedById" UUID NOT NULL,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hostel_exeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hostel_incident" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "hostelId" UUID NOT NULL,
    "roomId" UUID,
    "category" TEXT NOT NULL DEFAULT 'MAINTENANCE',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "reportedById" UUID NOT NULL,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hostel_incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_trip" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'AM_PICKUP',
    "name" TEXT,
    "departTime" TEXT NOT NULL,
    "daysOfWeek" JSONB NOT NULL DEFAULT '["MON","TUE","WED","THU","FRI"]',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transport_trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_boarding" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "tripId" UUID,
    "routeId" UUID NOT NULL,
    "passengerId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'PICKUP',
    "status" TEXT NOT NULL DEFAULT 'BOARDED',
    "method" TEXT NOT NULL DEFAULT 'MANUAL',
    "stopId" UUID,
    "recordedById" UUID NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transport_boarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_maintenance" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'SERVICE',
    "date" DATE NOT NULL,
    "costMinor" INTEGER NOT NULL DEFAULT 0,
    "odometerKm" INTEGER,
    "litres" DOUBLE PRECISION,
    "vendor" TEXT,
    "notes" TEXT,
    "recordedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_maintenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_location" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "speedKph" DOUBLE PRECISION,
    "headingDeg" DOUBLE PRECISION,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_location_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hostel_attendance_schoolId_idx" ON "hostel_attendance"("schoolId");

-- CreateIndex
CREATE INDEX "hostel_attendance_schoolId_hostelId_date_idx" ON "hostel_attendance"("schoolId", "hostelId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "hostel_attendance_hostelId_studentId_date_key" ON "hostel_attendance"("hostelId", "studentId", "date");

-- CreateIndex
CREATE INDEX "hostel_exeat_schoolId_idx" ON "hostel_exeat"("schoolId");

-- CreateIndex
CREATE INDEX "hostel_exeat_schoolId_hostelId_status_idx" ON "hostel_exeat"("schoolId", "hostelId", "status");

-- CreateIndex
CREATE INDEX "hostel_exeat_schoolId_studentId_idx" ON "hostel_exeat"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "hostel_incident_schoolId_idx" ON "hostel_incident"("schoolId");

-- CreateIndex
CREATE INDEX "hostel_incident_schoolId_hostelId_status_idx" ON "hostel_incident"("schoolId", "hostelId", "status");

-- CreateIndex
CREATE INDEX "transport_trip_schoolId_idx" ON "transport_trip"("schoolId");

-- CreateIndex
CREATE INDEX "transport_trip_schoolId_routeId_idx" ON "transport_trip"("schoolId", "routeId");

-- CreateIndex
CREATE INDEX "transport_boarding_schoolId_idx" ON "transport_boarding"("schoolId");

-- CreateIndex
CREATE INDEX "transport_boarding_schoolId_routeId_date_idx" ON "transport_boarding"("schoolId", "routeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "transport_boarding_passengerId_date_direction_key" ON "transport_boarding"("passengerId", "date", "direction");

-- CreateIndex
CREATE INDEX "vehicle_maintenance_schoolId_idx" ON "vehicle_maintenance"("schoolId");

-- CreateIndex
CREATE INDEX "vehicle_maintenance_schoolId_vehicleId_date_idx" ON "vehicle_maintenance"("schoolId", "vehicleId", "date");

-- CreateIndex
CREATE INDEX "vehicle_location_schoolId_idx" ON "vehicle_location"("schoolId");

-- CreateIndex
CREATE INDEX "vehicle_location_schoolId_vehicleId_recordedAt_idx" ON "vehicle_location"("schoolId", "vehicleId", "recordedAt");

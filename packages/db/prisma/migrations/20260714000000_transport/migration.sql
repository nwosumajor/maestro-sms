-- Transport Management: vehicles, routes, stops, assignments. Tenant-scoped.
-- RLS applied separately (prisma/rls/37).
CREATE TABLE "vehicle" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "regNumber" TEXT,
  "capacity" INTEGER NOT NULL DEFAULT 0,
  "customFields" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vehicle_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "vehicle_schoolId_idx" ON "vehicle"("schoolId");

CREATE TABLE "transport_route" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "vehicleId" UUID,
  "sessionId" UUID,
  "fareMode" TEXT NOT NULL DEFAULT 'FLAT',
  "flatFareMinor" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "customFields" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "transport_route_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "transport_route_schoolId_idx" ON "transport_route"("schoolId");
CREATE INDEX "transport_route_schoolId_status_idx" ON "transport_route"("schoolId", "status");

CREATE TABLE "route_stop" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "routeId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 0,
  "fareMinor" INTEGER NOT NULL DEFAULT 0,
  "pickupTime" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "route_stop_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "route_stop_schoolId_idx" ON "route_stop"("schoolId");
CREATE INDEX "route_stop_schoolId_routeId_idx" ON "route_stop"("schoolId", "routeId");

CREATE TABLE "transport_assignment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "routeId" UUID NOT NULL,
  "stopId" UUID,
  "passengerId" UUID NOT NULL,
  "passengerType" TEXT NOT NULL DEFAULT 'STUDENT',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "transport_assignment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "transport_assignment_schoolId_idx" ON "transport_assignment"("schoolId");
CREATE INDEX "transport_assignment_schoolId_passengerId_idx" ON "transport_assignment"("schoolId", "passengerId");
CREATE INDEX "transport_assignment_routeId_status_idx" ON "transport_assignment"("routeId", "status");

ALTER TABLE "transport_route" ADD CONSTRAINT "transport_route_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "route_stop" ADD CONSTRAINT "route_stop_routeId_fkey"
  FOREIGN KEY ("routeId") REFERENCES "transport_route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_assignment" ADD CONSTRAINT "transport_assignment_routeId_fkey"
  FOREIGN KEY ("routeId") REFERENCES "transport_route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_assignment" ADD CONSTRAINT "transport_assignment_stopId_fkey"
  FOREIGN KEY ("stopId") REFERENCES "route_stop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

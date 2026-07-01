-- A transport driver assigned to a vehicle; a driver sees only their own vehicle.
ALTER TABLE "vehicle" ADD COLUMN "driverId" UUID;

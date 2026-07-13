-- Comprehensive onboarding intake: school profile (type/location/website),
-- approximate scale (students/staff — students also drive the price estimate),
-- the requester's role, and their current system. All requester-supplied,
-- nullable (older rows predate the fields); global table, no RLS change.
ALTER TABLE "onboarding_request"
  ADD COLUMN "schoolType" TEXT,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "state" TEXT,
  ADD COLUMN "country" TEXT,
  ADD COLUMN "website" TEXT,
  ADD COLUMN "studentCount" INTEGER,
  ADD COLUMN "staffCount" INTEGER,
  ADD COLUMN "contactRole" TEXT,
  ADD COLUMN "currentSystem" TEXT;

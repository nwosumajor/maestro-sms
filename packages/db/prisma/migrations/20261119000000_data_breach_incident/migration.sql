-- =============================================================================
-- data_breach_incident — GDPR Art. 33/34, the 72-hour clock
-- =============================================================================
-- A school under GDPR must notify its supervisory authority within 72 hours of
-- BECOMING AWARE of a personal-data breach, and must tell the affected people
-- when the risk to them is high. A school holding children's data is precisely
-- the case the regulation is written for, and the platform had nowhere to record
-- any of it.
--
-- The deadline runs from `discoveredAt` — awareness — not from creation. Those
-- are different moments and only one starts the clock.
--
-- Guarded so re-running is a no-op: a failed migration blocks every later one and
-- takes the API down on boot (PR #21).
-- =============================================================================

CREATE TABLE IF NOT EXISTS "data_breach_incident" (
    "id"                   UUID NOT NULL,
    "schoolId"             UUID NOT NULL,
    "title"                TEXT NOT NULL,
    "description"          TEXT NOT NULL,
    "discoveredAt"         TIMESTAMP(3) NOT NULL,
    "status"               TEXT NOT NULL DEFAULT 'OPEN',
    "riskLevel"            TEXT NOT NULL DEFAULT 'HIGH',
    "affectedCount"        INTEGER NOT NULL DEFAULT 0,
    "dataCategories"       TEXT,
    "notifiedAuthorityAt"  TIMESTAMP(3),
    "notifiedSubjectsAt"   TIMESTAMP(3),
    "noNotificationReason" TEXT,
    "reportedById"         UUID NOT NULL,
    "closedAt"             TIMESTAMP(3),
    "closedById"           UUID,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_breach_incident_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "data_breach_incident_schoolId_idx" ON "data_breach_incident"("schoolId");
-- Serves the open-incidents list, which is what the compliance page opens with.
CREATE INDEX IF NOT EXISTS "data_breach_incident_schoolId_status_idx" ON "data_breach_incident"("schoolId", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'data_breach_incident_schoolId_fkey') THEN
    ALTER TABLE "data_breach_incident" ADD CONSTRAINT "data_breach_incident_schoolId_fkey"
      FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- Reporter and closer follow the documented "scalar column + DB FK, no Prisma
  -- relation" pattern. RESTRICT: deleting a person must not erase who reported a
  -- breach.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'data_breach_incident_reportedById_fkey') THEN
    ALTER TABLE "data_breach_incident" ADD CONSTRAINT "data_breach_incident_reportedById_fkey"
      FOREIGN KEY ("reportedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'data_breach_incident_closedById_fkey') THEN
    ALTER TABLE "data_breach_incident" ADD CONSTRAINT "data_breach_incident_closedById_fkey"
      FOREIGN KEY ("closedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

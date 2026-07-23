-- Scan events — append-only movement/activity log from the ID-card scan desk.
CREATE TABLE "scan_event" (
  "id"          UUID NOT NULL,
  "schoolId"    UUID NOT NULL,
  "memberId"    UUID NOT NULL,
  "scannedById" UUID NOT NULL,
  "purpose"     TEXT NOT NULL,
  "note"        TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scan_event_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "scan_event_schoolId_idx" ON "scan_event" ("schoolId");
CREATE INDEX "scan_event_schoolId_memberId_idx" ON "scan_event" ("schoolId", "memberId");
CREATE INDEX "scan_event_schoolId_createdAt_idx" ON "scan_event" ("schoolId", "createdAt");
ALTER TABLE "scan_event" ADD CONSTRAINT "scan_event_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "scan_event" ADD CONSTRAINT "scan_event_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "user"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "scan_event" ADD CONSTRAINT "scan_event_scannedById_fkey" FOREIGN KEY ("scannedById") REFERENCES "user"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- Parent-initiated meeting requests.
--
-- The teacher is the approver: they own the time. Leadership gets visibility
-- and an exception path, plus an explicit per-school opt-in to gate every one.

ALTER TABLE "school" ADD COLUMN IF NOT EXISTS "requireMeetingApproval" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "meeting_request" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "schoolId"     UUID NOT NULL,
  "parentId"     UUID NOT NULL,
  "studentId"    UUID NOT NULL,
  "teacherId"    UUID NOT NULL,
  "topic"        TEXT NOT NULL,
  "note"         TEXT,
  "status"       TEXT NOT NULL DEFAULT 'PENDING_TEACHER',
  "decidedById"  UUID,
  "decisionNote" TEXT,
  "slotId"       UUID,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "meeting_request_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "meeting_request_schoolId_idx" ON "meeting_request"("schoolId");
-- The teacher's inbox and the staleness sweep both filter on (teacher, status).
CREATE INDEX IF NOT EXISTS "meeting_request_schoolId_teacherId_status_idx"
  ON "meeting_request"("schoolId", "teacherId", "status");
-- The parent's own list.
CREATE INDEX IF NOT EXISTS "meeting_request_schoolId_parentId_status_idx"
  ON "meeting_request"("schoolId", "parentId", "status");

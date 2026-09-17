-- =============================================================================
-- Retention for the RAW staff clock-in/out scan stream
-- =============================================================================
-- `staff_attendance_event` is append-only and had no purge path at all, while
-- both of its siblings were handled: `scan_event` is purged on the school's
-- privacy window and `attendance_record` is partitioned by month. Projected at
-- 5,000 schools over five years it is the largest unmanaged table on the
-- platform (~1.3B rows / ~305 GB), carried through every backup and every
-- restore drill.
--
-- The DAY ROW (`staff_attendance`) is never purged at any age — it is the
-- employment record, and it is a PROJECTION of these scans, so the summary
-- survives the evidence it was drawn from.
--
-- The window is its OWN column rather than `integrityRetentionDays`: that one
-- governs surveillance data about minors and a school is behaving well by
-- setting it short, whereas these scans are employment evidence about adults.
-- Coupling them would let a privacy decision silently destroy a school's own
-- lateness and pay-dispute evidence.
-- =============================================================================

ALTER TABLE "school"
  ADD COLUMN IF NOT EXISTS "staffAttendanceEventRetentionDays" INTEGER NOT NULL DEFAULT 730;

-- What a run actually removed, and under which window. The window is NULLABLE
-- because every run recorded before this migration applied no staff window at
-- all — a different fact from having applied a window of zero, and one the
-- history has to keep saying if it is to stay interpretable.
ALTER TABLE "integrity_retention_run"
  ADD COLUMN IF NOT EXISTS "staffEventsDeleted"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "staffEventRetentionDays" INTEGER;

-- No new index: the purge predicate is (schoolId, date < cutoff) and
-- `staff_attendance_event_schoolId_date_idx` from 20270310000000 already serves
-- it exactly. An index nothing selects is write amplification, and this table
-- takes two writes per member of staff per day.

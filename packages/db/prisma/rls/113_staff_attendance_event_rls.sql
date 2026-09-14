-- =============================================================================
-- 113: staff_attendance_event — every arrival and departure scan, append-only
-- =============================================================================
-- Tenant-scoped, non-null schoolId, standard RLS. INSERT and SELECT only.
--
-- NO UPDATE, NO DELETE, and that is the point of the table. `staff_attendance`
-- is a PROJECTION (first IN, last OUT) and is corrected by people — an amendment
-- must never be able to reach back and rewrite the scan it contradicts, or the
-- record stops being evidence and the correction stops being visible as one.
-- The same reasoning as the payment ledger and the workflow audit log: keep what
-- happened, derive what it means.
--
-- This is behavioural data about named members of staff, read for lateness and
-- cited in disciplinary cases, so the tenant boundary here is doing real work.
--
-- Sentinel: staff_attendance_event_insert.
-- =============================================================================

ALTER TABLE "staff_attendance_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_attendance_event" FORCE  ROW LEVEL SECURITY;

CREATE POLICY staff_attendance_event_select ON "staff_attendance_event" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY staff_attendance_event_insert ON "staff_attendance_event" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT    ON "staff_attendance_event" TO major_user;
REVOKE UPDATE, DELETE    ON "staff_attendance_event" FROM major_user;
REVOKE TRUNCATE          ON "staff_attendance_event" FROM major_user;

-- =============================================================================
-- 77: teacher_unavailability — CSP timetable generator availability input.
-- =============================================================================
-- Standard tenant RLS. Full CRUD for the app role: availability is operational
-- config (not a ledger) — staff replace a teacher's set wholesale from the
-- timetable console. Sentinel: teacher_unavailability_delete.
-- =============================================================================

ALTER TABLE "teacher_unavailability" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "teacher_unavailability" FORCE ROW LEVEL SECURITY;

CREATE POLICY teacher_unavailability_select ON "teacher_unavailability" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY teacher_unavailability_insert ON "teacher_unavailability" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY teacher_unavailability_update ON "teacher_unavailability" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY teacher_unavailability_delete ON "teacher_unavailability" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "teacher_unavailability" TO major_user;
REVOKE TRUNCATE ON "teacher_unavailability" FROM major_user;

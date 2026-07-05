-- =============================================================================
-- SubjectResult (subject_result) RLS + grants
-- =============================================================================
-- Term-weighted subject grades. Tenant-scoped read/write with the same
-- fail-closed predicate as the rest of the system. Grades are academic RECORDS:
-- the app role gets SELECT/INSERT/UPDATE but NO DELETE (corrections are UPDATEs;
-- there is no hard-delete path). Run as the privileged migration role.
-- Sentinel (entrypoint idempotency key): the LAST policy created,
-- subject_result_update.
-- =============================================================================

ALTER TABLE subject_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_result FORCE  ROW LEVEL SECURITY;

CREATE POLICY subject_result_select ON subject_result FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

CREATE POLICY subject_result_insert ON subject_result FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

CREATE POLICY subject_result_update ON subject_result FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON subject_result TO major_user;

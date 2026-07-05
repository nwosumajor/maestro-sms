-- =============================================================================
-- SubjectSelection (subject_selection) RLS + grants
-- =============================================================================
-- Per-term student subject choices under 2-stage maker-checker. Tenant-scoped
-- read/write, fail-closed predicate. Lifecycle is status-driven (a REJECTED row
-- is resubmitted in place) so the app role gets NO DELETE. Run as the
-- privileged migration role. Sentinel (entrypoint idempotency key): the LAST
-- policy created, subject_selection_update.
-- =============================================================================

ALTER TABLE subject_selection ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_selection FORCE  ROW LEVEL SECURITY;

CREATE POLICY subject_selection_select ON subject_selection FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

CREATE POLICY subject_selection_insert ON subject_selection FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

CREATE POLICY subject_selection_update ON subject_selection FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON subject_selection TO major_user;

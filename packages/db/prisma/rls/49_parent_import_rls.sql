-- =============================================================================
-- ParentImportBatch (parent_import_batch) RLS + grants
-- =============================================================================
-- Staged bulk parent-onboarding batches under maker-checker. Tenant-scoped
-- read/write, fail-closed predicate. Lifecycle is status-driven (PENDING ->
-- APPROVED | REJECTED), so the app role gets NO DELETE. Run as the privileged
-- migration role. Sentinel (entrypoint idempotency key): the LAST policy
-- created, parent_import_batch_update.
-- =============================================================================

ALTER TABLE parent_import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE parent_import_batch FORCE  ROW LEVEL SECURITY;

CREATE POLICY parent_import_batch_select ON parent_import_batch FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

CREATE POLICY parent_import_batch_insert ON parent_import_batch FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

CREATE POLICY parent_import_batch_update ON parent_import_batch FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON parent_import_batch TO major_user;

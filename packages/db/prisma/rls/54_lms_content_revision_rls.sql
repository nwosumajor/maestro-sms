-- =============================================================================
-- RLS: lms_content_revision — LMS content version history (tenant-scoped).
-- SELECT/INSERT for the app role; NO UPDATE/DELETE (an immutable audit-style
-- history, like audit_log). Row visibility further narrowed in the service
-- (staff-of-class only; never exposed to students).
-- Sentinel policy (docker-entrypoint idempotency key): lms_content_revision_insert
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lms_content_revision'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %1$s_select ON %1$I FOR SELECT
      USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_insert ON %1$I FOR INSERT
      WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format('GRANT  SELECT, INSERT    ON %I TO major_user', t);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM major_user', t);
  END LOOP;
END $$;

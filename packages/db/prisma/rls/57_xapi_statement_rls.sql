-- =============================================================================
-- RLS: xapi_statement — the xAPI Learning Record Store (tenant-scoped).
-- SELECT/INSERT only — statements are IMMUTABLE (never updated or deleted), like
-- audit_log. Row visibility further narrowed in the service (staff-of-class →
-- class statements; student → own).
-- Sentinel policy (docker-entrypoint idempotency key): xapi_statement_insert
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['xapi_statement'] LOOP
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

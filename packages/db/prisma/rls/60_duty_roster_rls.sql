-- =============================================================================
-- RLS: duty_assignment (tenant-scoped duty roster). Full CRUD for the app role —
-- a roster is a plan, not a ledger (unassign = DELETE, audited in app code).
-- Row visibility further narrowed in the service (staff see own; hr sees all).
-- Sentinel policy (docker-entrypoint idempotency key): duty_assignment_delete
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['duty_assignment'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %1$s_select ON %1$I FOR SELECT
      USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_insert ON %1$I FOR INSERT
      WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_update ON %1$I FOR UPDATE
      USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
      WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_delete ON %1$I FOR DELETE
      USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format('GRANT  SELECT, INSERT, UPDATE, DELETE ON %I TO major_user', t);
    EXECUTE format('REVOKE TRUNCATE ON %I FROM major_user', t);
  END LOOP;
END $$;

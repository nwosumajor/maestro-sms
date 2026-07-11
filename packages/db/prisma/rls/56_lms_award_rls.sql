-- =============================================================================
-- RLS: lms_award — achievement badges (tenant-scoped). SELECT/INSERT/DELETE for
-- the app role (a teacher may revoke a mistaken award; it's recognition, not a
-- legal record) — no UPDATE (an award is created or revoked, never edited).
-- Row visibility further narrowed in the service (teacher-of-class → all;
-- student → own; guardian → their children).
-- Sentinel policy (docker-entrypoint idempotency key): lms_award_delete
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lms_award'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %1$s_select ON %1$I FOR SELECT
      USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_insert ON %1$I FOR INSERT
      WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_delete ON %1$I FOR DELETE
      USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format('GRANT  SELECT, INSERT, DELETE ON %I TO major_user', t);
    EXECUTE format('REVOKE UPDATE, TRUNCATE       ON %I FROM major_user', t);
  END LOOP;
END $$;

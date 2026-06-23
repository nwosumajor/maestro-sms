-- =============================================================================
-- Integrity retention — RLS for the per-run audit table + the privileged role
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md). Run AFTER the Prisma migration
-- 20260620090000_integrity_retention, as the PRIVILEGED migration role.
--
-- This completes the retention design sketched in 01_integrity_rls.sql:
--   "Append-only tables cannot be pruned by the app role (no DELETE grant), so
--    retention runs as a SEPARATE privileged scheduled job ... applied per tenant."
--
-- TWO roles are involved:
--   * major_user      — the least-privilege APP role. Gets SELECT ONLY on the
--                       run table (so school_admin can view retention history),
--                       and still has NO DELETE on the append-only telemetry.
--   * the RETENTION role — runs the purge. It must DELETE the append-only rows
--                       and INSERT run records, which means it must bypass RLS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- integrity_retention_run  (APP role: read-only; written only by the purge job)
-- -----------------------------------------------------------------------------
-- SECURITY: immutable from the app. Only a SELECT policy exists, and we REVOKE
-- INSERT/UPDATE/DELETE so an accidental future permissive policy can't re-open
-- writes. The purge job writes this table while bypassing RLS (see below).
ALTER TABLE "integrity_retention_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integrity_retention_run" FORCE  ROW LEVEL SECURITY;

CREATE POLICY integrity_retention_run_select ON "integrity_retention_run"
  FOR SELECT USING (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

GRANT  SELECT                   ON "integrity_retention_run" TO major_user;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "integrity_retention_run" FROM major_user;

-- =============================================================================
-- The retention role (production hardening).
-- =============================================================================
-- In the current local/compose stack the purge connects with the privileged
-- migration superuser (DATABASE_MIGRATE_URL), which bypasses RLS implicitly. For
-- production, provision a DEDICATED, NON-superuser role so the purge holds the
-- minimum rights it needs and nothing more (Golden Rule #4), and point
-- DATABASE_RETENTION_URL at it:
--
--   CREATE ROLE sms_retention LOGIN PASSWORD '...';
--   -- It must see/delete rows across all tenants for the sweep, so it bypasses
--   -- RLS rather than relying on per-tenant GUCs. This is the ONE role allowed
--   -- to do so, and only these tables:
--   ALTER ROLE sms_retention BYPASSRLS;
--   GRANT SELECT          ON "school"                  TO sms_retention; -- read window
--   GRANT DELETE          ON "integrity_signal"        TO sms_retention;
--   GRANT DELETE          ON "submission_draft"        TO sms_retention;
--   GRANT DELETE          ON "submission_telemetry"    TO sms_retention;
--   GRANT SELECT, INSERT  ON "integrity_retention_run" TO sms_retention;
--   -- No DROP/ALTER/TRUNCATE, no rights on any other table.
--
-- The app role (major_user) is deliberately NOT granted any of the above; it
-- cannot purge, only read the resulting run history.
-- =============================================================================

-- =============================================================================
-- Foundation RLS + grants + login lookup
-- =============================================================================
-- Run AFTER the tables exist, as the PRIVILEGED migration role (Golden Rule #4).
-- Global tables (school, role, permission, role_permission) are RLS-EXEMPT.
-- Tenant tables (user, user_role, audit_log, integrity_consent) are RLS-enforced
-- with the same fail-closed predicate the integrity tables use.
-- Adjust `major_user` to the foundation's app role if different.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- user  (read/write within tenant; no hard delete)
-- ---------------------------------------------------------------------------
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user" FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_select ON "user" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY user_insert ON "user" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY user_update ON "user" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- user_role  (read/write within tenant)
-- ---------------------------------------------------------------------------
ALTER TABLE "user_role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_role" FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_role_select ON "user_role" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY user_role_insert ON "user_role" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY user_role_delete ON "user_role" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- audit_log  (APPEND-ONLY: SELECT + INSERT policies only)
-- ---------------------------------------------------------------------------
-- SECURITY: tamper-evident audit trail (Golden Rule #5). No UPDATE/DELETE policy
-- and privileges revoked, so entries can never be altered by the app.
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE  ROW LEVEL SECURITY;
CREATE POLICY audit_log_select ON "audit_log" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY audit_log_insert ON "audit_log" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- integrity_consent  (read/write within tenant; no hard delete -> keep history)
-- ---------------------------------------------------------------------------
ALTER TABLE "integrity_consent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integrity_consent" FORCE  ROW LEVEL SECURITY;
CREATE POLICY consent_select ON "integrity_consent" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY consent_insert ON "integrity_consent" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY consent_update ON "integrity_consent" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

-- =============================================================================
-- Least-privilege grants for the app role.
-- =============================================================================
GRANT  SELECT, INSERT, UPDATE   ON "user"              TO major_user;
GRANT  SELECT, INSERT, DELETE   ON "user_role"         TO major_user;
GRANT  SELECT, INSERT           ON "audit_log"         TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log"         FROM major_user;
GRANT  SELECT, INSERT, UPDATE   ON "integrity_consent" TO major_user;
REVOKE DELETE, TRUNCATE         ON "integrity_consent" FROM major_user;

-- Global (RLS-exempt) reference tables: read-only for the app.
GRANT SELECT ON "school"          TO major_user;
GRANT SELECT ON "role"            TO major_user;
GRANT SELECT ON "permission"      TO major_user;
GRANT SELECT ON "role_permission" TO major_user;

-- =============================================================================
-- Login lookup: SECURITY DEFINER so the least-privilege app role can find a user
-- by email BEFORE any tenant context exists, WITHOUT RLS exposing other tenants.
-- Owned by the (privileged) migration role; bypasses RLS on "user"; returns only
-- what login needs. The app then verifies the password in code (bcrypt).
-- =============================================================================
CREATE OR REPLACE FUNCTION app_login_lookup(p_email text)
RETURNS TABLE (id uuid, school_id uuid, password_hash text, status text, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u."schoolId", u."passwordHash", u.status, u.name
  FROM "user" u
  WHERE u.email = p_email
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION app_login_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_login_lookup(text) TO major_user;

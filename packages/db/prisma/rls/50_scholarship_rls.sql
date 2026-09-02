-- ============================================================================
-- 50: scholarship — platform-owned program (global) + tenant-scoped application
-- ============================================================================
-- Mirrors the Ultimate arena's two-halves posture:
--   (A) scholarship_program — GLOBAL, platform-owned, RLS-EXEMPT (like
--       school/plan_price/role). Every app-role query may READ programs (to show
--       OPEN ones); program WRITES go only through the PRIVILEGED client
--       (super_admin, step-up + audited), whose role bypasses RLS. The
--       least-privilege app role has NO write grant here.
--   (B) scholarship_application — TENANT-SCOPED (non-null schoolId + standard
--       RLS). A parent/teacher applies for a student in THEIR school; the
--       platform owner reviews across tenants via the privileged path. Academic
--       RECORD: SELECT/INSERT/UPDATE but NO DELETE (decisions are append-only).
-- Run as the privileged migration role. Sentinel (entrypoint idempotency key):
-- the LAST policy created, scholarship_question_deny_all.
-- ============================================================================

-- (A) GLOBAL program — RLS-exempt, read-only for the app role.
ALTER TABLE "scholarship_program" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scholarship_program" FORCE  ROW LEVEL SECURITY;

GRANT SELECT ON "scholarship_program" TO major_user;

CREATE POLICY scholarship_program_select ON "scholarship_program" FOR SELECT
  USING (true);

-- (B) TENANT-SCOPED application.
ALTER TABLE "scholarship_application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scholarship_application" FORCE  ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON "scholarship_application" TO major_user;

CREATE POLICY scholarship_application_select ON "scholarship_application" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

CREATE POLICY scholarship_application_insert ON "scholarship_application" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

CREATE POLICY scholarship_application_update ON "scholarship_application" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

-- ============================================================================
-- (C) GLOBAL question library — platform-owned, and DENY-ALL to the app role.
--
-- Stricter than `scholarship_program` above, which the app role may SELECT.
-- Every row here carries an ANSWER KEY to a cross-school competition, and no
-- tenant context ever needs one: a question reaches a candidate only by being
-- COPIED into a programme's paper and then materialised as a CbtQuestion inside
-- that school's own tenant. So the app role is granted nothing at all and the
-- owner's privileged client is the only reader — Golden Rule #7, the more
-- restrictive option, with the reason written down.
--
-- The same posture as `agent_commission`, and for the same kind of reason.
-- ============================================================================
ALTER TABLE "scholarship_question" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scholarship_question" FORCE  ROW LEVEL SECURITY;

REVOKE ALL ON "scholarship_question" FROM major_user;

CREATE POLICY scholarship_question_deny_all ON "scholarship_question" FOR ALL
  USING (false) WITH CHECK (false);

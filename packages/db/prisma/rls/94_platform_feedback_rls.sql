-- =============================================================================
-- platform_feedback RLS + grants
-- =============================================================================
-- Cross-tenant complaint/suggestion channel to the platform owner. Tenant-scoped
-- (school_id non-null = the sender's school); standard fail-closed predicate. The
-- app role may SELECT (read own, RLS-scoped) + INSERT (send); it may NOT
-- UPDATE/DELETE — the platform review path mutates it via the privileged client,
-- and a sender can never edit or delete submitted feedback. Sentinel:
-- platform_feedback_insert.
-- =============================================================================

ALTER TABLE "platform_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_feedback" FORCE  ROW LEVEL SECURITY;
CREATE POLICY platform_feedback_select ON "platform_feedback" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY platform_feedback_insert ON "platform_feedback" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT ON "platform_feedback" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "platform_feedback" FROM major_user;

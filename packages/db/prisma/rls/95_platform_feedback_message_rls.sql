-- =============================================================================
-- platform_feedback_message RLS + grants
-- =============================================================================
-- The two-way conversation on a feedback item. Tenant-scoped (school_id = the
-- parent feedback's school); standard fail-closed predicate. The app role may
-- SELECT (the sender reads their own thread, RLS-scoped) + INSERT (the sender
-- replies); it may NOT UPDATE/DELETE — a conversation record is immutable, and
-- the platform team reads/writes ACROSS tenants via the privileged client.
-- Sentinel: platform_feedback_message_insert.
-- =============================================================================

ALTER TABLE "platform_feedback_message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_feedback_message" FORCE  ROW LEVEL SECURITY;
CREATE POLICY platform_feedback_message_select ON "platform_feedback_message" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY platform_feedback_message_insert ON "platform_feedback_message" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT ON "platform_feedback_message" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "platform_feedback_message" FROM major_user;

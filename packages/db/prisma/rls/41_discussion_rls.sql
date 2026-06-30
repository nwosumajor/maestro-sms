-- =============================================================================
-- discussion_group / discussion_post / discussion_comment RLS + grants
-- =============================================================================
-- Tenant-scoped (school_id non-null). Standard fail-closed predicate. App role
-- gets full CRUD; audience scoping + moderation are enforced in the service. Run
-- as the privileged migration role. Sentinel: discussion_comment_delete.
-- =============================================================================

ALTER TABLE "discussion_group" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "discussion_group" FORCE  ROW LEVEL SECURITY;
CREATE POLICY discussion_group_select ON "discussion_group" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discussion_group_insert ON "discussion_group" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discussion_group_update ON "discussion_group" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discussion_group_delete ON "discussion_group" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "discussion_post" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "discussion_post" FORCE  ROW LEVEL SECURITY;
CREATE POLICY discussion_post_select ON "discussion_post" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discussion_post_insert ON "discussion_post" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discussion_post_update ON "discussion_post" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discussion_post_delete ON "discussion_post" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "discussion_comment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "discussion_comment" FORCE  ROW LEVEL SECURITY;
CREATE POLICY discussion_comment_select ON "discussion_comment" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discussion_comment_insert ON "discussion_comment" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discussion_comment_update ON "discussion_comment" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discussion_comment_delete ON "discussion_comment" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "discussion_group"   TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "discussion_post"    TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "discussion_comment" TO major_user;

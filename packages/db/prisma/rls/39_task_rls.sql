-- =============================================================================
-- task / task_assignment / task_comment RLS + grants
-- =============================================================================
-- Tenant-scoped (school_id non-null). Standard fail-closed predicate. App role
-- gets full CRUD; relationship scoping (creator/assignee) is enforced in the
-- service. Run as the privileged migration role. Sentinel: task_comment_delete.
-- =============================================================================

ALTER TABLE "task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task" FORCE  ROW LEVEL SECURITY;
CREATE POLICY task_select ON "task" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY task_insert ON "task" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY task_update ON "task" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY task_delete ON "task" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "task_assignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_assignment" FORCE  ROW LEVEL SECURITY;
CREATE POLICY task_assignment_select ON "task_assignment" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY task_assignment_insert ON "task_assignment" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY task_assignment_update ON "task_assignment" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY task_assignment_delete ON "task_assignment" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "task_comment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_comment" FORCE  ROW LEVEL SECURITY;
CREATE POLICY task_comment_select ON "task_comment" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY task_comment_insert ON "task_comment" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY task_comment_update ON "task_comment" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY task_comment_delete ON "task_comment" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "task"            TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "task_assignment" TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "task_comment"    TO major_user;

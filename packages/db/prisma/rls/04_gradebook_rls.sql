-- =============================================================================
-- Gradebook RLS + grants
-- =============================================================================
-- `grade` is tenant-scoped read/write. Same fail-closed predicate as the rest.
-- Relationship scoping (teacher->own classes; student/parent->own/published) is
-- enforced in the service layer ON TOP of this tenant isolation. Run as the
-- privileged migration role. Adjust `major_user` if the app role differs.
-- =============================================================================

ALTER TABLE "grade" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "grade" FORCE  ROW LEVEL SECURITY;

CREATE POLICY grade_select ON "grade" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY grade_insert ON "grade" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY grade_update ON "grade" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON "grade" TO major_user;

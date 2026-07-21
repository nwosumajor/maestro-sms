-- =============================================================================
-- 85: lesson_cover — dated teacher substitutions.
-- =============================================================================
-- Standard tenant RLS, full CRUD for the app role (operational config —
-- timetable managers assign/remove). Sentinel: lesson_cover_delete.
-- =============================================================================

ALTER TABLE "lesson_cover" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lesson_cover" FORCE ROW LEVEL SECURITY;

CREATE POLICY lesson_cover_select ON "lesson_cover" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY lesson_cover_insert ON "lesson_cover" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY lesson_cover_update ON "lesson_cover" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY lesson_cover_delete ON "lesson_cover" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "lesson_cover" TO major_user;
REVOKE TRUNCATE ON "lesson_cover" FROM major_user;

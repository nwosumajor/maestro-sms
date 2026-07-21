-- =============================================================================
-- 87: exam_sitting + exam_seat + exam_invigilator — physical exam logistics.
-- =============================================================================
-- Standard tenant RLS, full CRUD for the app role. Relationship scoping in
-- ExamService. Sentinel: exam_invigilator_delete.
-- =============================================================================

ALTER TABLE "exam_sitting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exam_sitting" FORCE ROW LEVEL SECURITY;
CREATE POLICY exam_sitting_select ON "exam_sitting" FOR SELECT USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY exam_sitting_insert ON "exam_sitting" FOR INSERT WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY exam_sitting_update ON "exam_sitting" FOR UPDATE USING ("schoolId" = current_setting('app.current_school_id', true)::uuid) WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY exam_sitting_delete ON "exam_sitting" FOR DELETE USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "exam_sitting" TO major_user;
REVOKE TRUNCATE ON "exam_sitting" FROM major_user;

ALTER TABLE "exam_seat" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exam_seat" FORCE ROW LEVEL SECURITY;
CREATE POLICY exam_seat_select ON "exam_seat" FOR SELECT USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY exam_seat_insert ON "exam_seat" FOR INSERT WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY exam_seat_delete ON "exam_seat" FOR DELETE USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT SELECT, INSERT, DELETE ON "exam_seat" TO major_user;
REVOKE UPDATE, TRUNCATE ON "exam_seat" FROM major_user;

ALTER TABLE "exam_invigilator" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exam_invigilator" FORCE ROW LEVEL SECURITY;
CREATE POLICY exam_invigilator_select ON "exam_invigilator" FOR SELECT USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY exam_invigilator_insert ON "exam_invigilator" FOR INSERT WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY exam_invigilator_delete ON "exam_invigilator" FOR DELETE USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT SELECT, INSERT, DELETE ON "exam_invigilator" TO major_user;
REVOKE UPDATE, TRUNCATE ON "exam_invigilator" FROM major_user;

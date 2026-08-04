-- Subject syllabus: standard tenant isolation. The plan and its weeks are
-- ordinary tenant data — no cross-tenant surface, no append-only requirement.
-- Least privilege: the app role gets exactly the verbs the service uses. RLS
-- confines WHICH rows; the GRANT decides which VERBS exist at all, and without
-- it every query is a 42501 regardless of the policies below.
GRANT SELECT, INSERT, UPDATE, DELETE ON "subject_syllabus" TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "subject_syllabus_item" TO major_user;

ALTER TABLE "subject_syllabus" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subject_syllabus" FORCE ROW LEVEL SECURITY;

CREATE POLICY subject_syllabus_select ON "subject_syllabus" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id')::uuid);
CREATE POLICY subject_syllabus_insert ON "subject_syllabus" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id')::uuid);
CREATE POLICY subject_syllabus_update ON "subject_syllabus" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id')::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id')::uuid);
CREATE POLICY subject_syllabus_delete ON "subject_syllabus" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id')::uuid);

ALTER TABLE "subject_syllabus_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subject_syllabus_item" FORCE ROW LEVEL SECURITY;

CREATE POLICY subject_syllabus_item_select ON "subject_syllabus_item" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id')::uuid);
CREATE POLICY subject_syllabus_item_insert ON "subject_syllabus_item" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id')::uuid);
CREATE POLICY subject_syllabus_item_update ON "subject_syllabus_item" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id')::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id')::uuid);
CREATE POLICY subject_syllabus_item_delete ON "subject_syllabus_item" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id')::uuid);

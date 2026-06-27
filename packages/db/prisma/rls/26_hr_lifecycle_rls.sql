-- =============================================================================
-- HR staff-lifecycle RLS + grants (checklists, documents, training)
-- =============================================================================
-- Run AFTER migration 20260627*_hr_staff_lifecycle, as the PRIVILEGED role. All
-- four tables are tenant-scoped; WHO may read/write is enforced in
-- StaffLifecycleService (hr.read / hr.write). No hard delete. Sentinel = LAST
-- policy: training_record_update.
-- =============================================================================

-- staff_checklist -------------------------------------------------------------
ALTER TABLE "staff_checklist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_checklist" FORCE  ROW LEVEL SECURITY;
CREATE POLICY staff_checklist_select ON "staff_checklist" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY staff_checklist_insert ON "staff_checklist" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY staff_checklist_update ON "staff_checklist" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "staff_checklist" TO major_user;
REVOKE DELETE, TRUNCATE       ON "staff_checklist" FROM major_user;

-- staff_checklist_item --------------------------------------------------------
ALTER TABLE "staff_checklist_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_checklist_item" FORCE  ROW LEVEL SECURITY;
CREATE POLICY staff_checklist_item_select ON "staff_checklist_item" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY staff_checklist_item_insert ON "staff_checklist_item" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY staff_checklist_item_update ON "staff_checklist_item" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "staff_checklist_item" TO major_user;
REVOKE DELETE, TRUNCATE       ON "staff_checklist_item" FROM major_user;

-- staff_document --------------------------------------------------------------
ALTER TABLE "staff_document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_document" FORCE  ROW LEVEL SECURITY;
CREATE POLICY staff_document_select ON "staff_document" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY staff_document_insert ON "staff_document" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY staff_document_update ON "staff_document" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "staff_document" TO major_user;
REVOKE DELETE, TRUNCATE       ON "staff_document" FROM major_user;

-- training_record -------------------------------------------------------------
ALTER TABLE "training_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "training_record" FORCE  ROW LEVEL SECURITY;
CREATE POLICY training_record_select ON "training_record" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY training_record_insert ON "training_record" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY training_record_update ON "training_record" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "training_record" TO major_user;
REVOKE DELETE, TRUNCATE       ON "training_record" FROM major_user;

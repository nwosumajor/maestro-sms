-- =============================================================================
-- HR appraisals + disciplinary RLS + grants
-- =============================================================================
-- Run AFTER migration 20260627*_hr_appraisals_disciplinary, as the PRIVILEGED
-- role. Tenant-scoped; WHO may act is enforced in the services (hr.appraisal.manage
-- / hr.disciplinary.manage + self-acknowledge). disciplinary_entry is APPEND-ONLY
-- (no UPDATE). No hard delete. Sentinel = LAST policy: disciplinary_entry_insert.
-- =============================================================================

-- appraisal -------------------------------------------------------------------
ALTER TABLE "appraisal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appraisal" FORCE  ROW LEVEL SECURITY;
CREATE POLICY appraisal_select ON "appraisal" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY appraisal_insert ON "appraisal" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY appraisal_update ON "appraisal" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "appraisal" TO major_user;
REVOKE DELETE, TRUNCATE       ON "appraisal" FROM major_user;

-- disciplinary_case -----------------------------------------------------------
ALTER TABLE "disciplinary_case" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "disciplinary_case" FORCE  ROW LEVEL SECURITY;
CREATE POLICY disciplinary_case_select ON "disciplinary_case" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY disciplinary_case_insert ON "disciplinary_case" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY disciplinary_case_update ON "disciplinary_case" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT, UPDATE ON "disciplinary_case" TO major_user;
REVOKE DELETE, TRUNCATE       ON "disciplinary_case" FROM major_user;

-- disciplinary_entry (append-only) --------------------------------------------
ALTER TABLE "disciplinary_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "disciplinary_entry" FORCE  ROW LEVEL SECURITY;
CREATE POLICY disciplinary_entry_select ON "disciplinary_entry" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY disciplinary_entry_insert ON "disciplinary_entry" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT ON "disciplinary_entry" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "disciplinary_entry" FROM major_user;

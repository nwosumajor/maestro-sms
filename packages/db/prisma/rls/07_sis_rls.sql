-- =============================================================================
-- SIS RLS + grants
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md). Run AFTER migration
-- 20260620100000_sis, as the PRIVILEGED migration role.
--
-- All three tables are tenant-scoped; same fail-closed predicate as the rest:
-- a missing app.current_school_id GUC yields NULL and matches no rows.
-- Relationship scoping (teacher-of-student / parent-of-child / self / school
-- staff) is enforced in SisService ON TOP of this tenant isolation.
--
-- Privilege posture (Golden Rule #7, restrictive): emergency contacts may be
-- removed, but student profiles and (especially) medical records are NEVER
-- hard-deleted by the app — there is no DELETE policy/grant for them. Sentinel
-- for the entrypoint apply guard = the LAST policy here: medical_record_update.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- student_profile  (read/write; NO delete)
-- -----------------------------------------------------------------------------
ALTER TABLE "student_profile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "student_profile" FORCE  ROW LEVEL SECURITY;

CREATE POLICY student_profile_select ON "student_profile" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY student_profile_insert ON "student_profile" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY student_profile_update ON "student_profile" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "student_profile" TO major_user;
REVOKE DELETE, TRUNCATE       ON "student_profile" FROM major_user;

-- -----------------------------------------------------------------------------
-- emergency_contact  (read/write incl. delete — a contact can be removed)
-- -----------------------------------------------------------------------------
ALTER TABLE "emergency_contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emergency_contact" FORCE  ROW LEVEL SECURITY;

CREATE POLICY emergency_contact_select ON "emergency_contact" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY emergency_contact_insert ON "emergency_contact" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY emergency_contact_update ON "emergency_contact" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY emergency_contact_delete ON "emergency_contact" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "emergency_contact" TO major_user;

-- -----------------------------------------------------------------------------
-- medical_record  (read/write; NO delete — sensitive, never hard-deleted)
-- -----------------------------------------------------------------------------
ALTER TABLE "medical_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "medical_record" FORCE  ROW LEVEL SECURITY;

CREATE POLICY medical_record_select ON "medical_record" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY medical_record_insert ON "medical_record" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY medical_record_update ON "medical_record" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "medical_record" TO major_user;
REVOKE DELETE, TRUNCATE       ON "medical_record" FROM major_user;

-- =============================================================================
-- HR RLS + grants
-- =============================================================================
-- Run AFTER migration 20260620210000_hr, as the PRIVILEGED role. employee is
-- tenant-scoped read/write; who may read/write is enforced in HrService (hr.read
-- / hr.write). Records are deactivated, not deleted: no DELETE. Sentinel = LAST
-- policy: employee_update.
-- =============================================================================

ALTER TABLE "employee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee" FORCE  ROW LEVEL SECURITY;

CREATE POLICY employee_select ON "employee" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY employee_insert ON "employee" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY employee_update ON "employee" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "employee" TO major_user;
REVOKE DELETE, TRUNCATE       ON "employee" FROM major_user;

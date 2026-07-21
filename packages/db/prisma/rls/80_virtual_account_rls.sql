-- =============================================================================
-- 80: student_virtual_account — per-student dedicated-NUBAN (bank transfer).
-- =============================================================================
-- Standard tenant RLS. Payment-routing record: SELECT/INSERT/UPDATE for the
-- app role (provision + deactivate), NEVER DELETE — a number parents may have
-- saved must stay traceable. Sentinel: student_virtual_account_update.
-- =============================================================================

ALTER TABLE "student_virtual_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "student_virtual_account" FORCE ROW LEVEL SECURITY;

CREATE POLICY student_virtual_account_select ON "student_virtual_account" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY student_virtual_account_insert ON "student_virtual_account" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY student_virtual_account_update ON "student_virtual_account" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON "student_virtual_account" TO major_user;
REVOKE DELETE, TRUNCATE ON "student_virtual_account" FROM major_user;

-- =============================================================================
-- discipline_complaint / discipline_assignee / discipline_evidence /
-- discipline_entry RLS + grants
-- =============================================================================
-- Tenant-scoped (school_id non-null). Standard fail-closed predicate. App role
-- gets full CRUD; relationship scoping (complainant/assignee/staff) is enforced in
-- the service. Run as the privileged migration role. Sentinel:
-- discipline_entry_delete.
-- =============================================================================

ALTER TABLE "discipline_complaint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "discipline_complaint" FORCE  ROW LEVEL SECURITY;
CREATE POLICY discipline_complaint_select ON "discipline_complaint" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discipline_complaint_insert ON "discipline_complaint" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discipline_complaint_update ON "discipline_complaint" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discipline_complaint_delete ON "discipline_complaint" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "discipline_assignee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "discipline_assignee" FORCE  ROW LEVEL SECURITY;
CREATE POLICY discipline_assignee_select ON "discipline_assignee" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discipline_assignee_insert ON "discipline_assignee" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discipline_assignee_update ON "discipline_assignee" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discipline_assignee_delete ON "discipline_assignee" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "discipline_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "discipline_evidence" FORCE  ROW LEVEL SECURITY;
CREATE POLICY discipline_evidence_select ON "discipline_evidence" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discipline_evidence_insert ON "discipline_evidence" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discipline_evidence_update ON "discipline_evidence" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discipline_evidence_delete ON "discipline_evidence" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "discipline_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "discipline_entry" FORCE  ROW LEVEL SECURITY;
CREATE POLICY discipline_entry_select ON "discipline_entry" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discipline_entry_insert ON "discipline_entry" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discipline_entry_update ON "discipline_entry" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY discipline_entry_delete ON "discipline_entry" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "discipline_complaint" TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "discipline_assignee"  TO major_user;
GRANT SELECT, INSERT                 ON "discipline_evidence"  TO major_user;
GRANT SELECT, INSERT                 ON "discipline_entry"     TO major_user;

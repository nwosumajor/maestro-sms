-- =============================================================================
-- 83: report_card_remark — per-student/term report-card narrative remarks.
-- =============================================================================
-- Standard tenant RLS, full CRUD for the app role (remarks are edited in place
-- before a card is issued). Relationship scoping (who may set which remark) is
-- in ReportCardRemarkService. Sentinel: report_card_remark_delete.
-- =============================================================================

ALTER TABLE "report_card_remark" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_card_remark" FORCE ROW LEVEL SECURITY;

CREATE POLICY report_card_remark_select ON "report_card_remark" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY report_card_remark_insert ON "report_card_remark" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY report_card_remark_update ON "report_card_remark" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY report_card_remark_delete ON "report_card_remark" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "report_card_remark" TO major_user;
REVOKE TRUNCATE ON "report_card_remark" FROM major_user;

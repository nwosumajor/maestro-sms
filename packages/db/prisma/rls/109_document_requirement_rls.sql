-- =============================================================================
-- 109: document_requirement — what this school asks a family or a candidate for
-- =============================================================================
-- Tenant-scoped configuration, edited by school staff. Full CRUD for the app
-- role: a school rewords its own list, reorders it, and switches entries off.
--
-- DELETE is permitted but the service does not offer it — a requirement that has
-- collected submissions is deactivated instead, and the FK from
-- document_submission RESTRICTs anyway, so a delete can only ever remove one
-- nothing has been filed against. The policy allows what the constraint already
-- bounds rather than pretending to be the control.
--
-- Sentinel: document_requirement_delete.
-- =============================================================================

ALTER TABLE "document_requirement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_requirement" FORCE  ROW LEVEL SECURITY;

CREATE POLICY document_requirement_select ON "document_requirement" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY document_requirement_insert ON "document_requirement" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY document_requirement_update ON "document_requirement" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY document_requirement_delete ON "document_requirement" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE, DELETE ON "document_requirement" TO major_user;
REVOKE TRUNCATE                       ON "document_requirement" FROM major_user;

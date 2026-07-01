-- =============================================================================
-- form / form_response RLS + grants
-- =============================================================================
-- Tenant-scoped (school_id non-null). Standard fail-closed predicate. App role
-- gets full CRUD; audience scoping + anonymity are enforced in the service. Run
-- as the privileged migration role. Sentinel: form_response_delete.
-- =============================================================================

ALTER TABLE "form" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "form" FORCE  ROW LEVEL SECURITY;
CREATE POLICY form_select ON "form" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY form_insert ON "form" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY form_update ON "form" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY form_delete ON "form" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "form_response" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "form_response" FORCE  ROW LEVEL SECURITY;
CREATE POLICY form_response_select ON "form_response" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY form_response_insert ON "form_response" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY form_response_update ON "form_response" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY form_response_delete ON "form_response" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "form"          TO major_user;
GRANT SELECT, INSERT                 ON "form_response" TO major_user;

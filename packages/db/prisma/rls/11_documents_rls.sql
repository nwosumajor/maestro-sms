-- =============================================================================
-- Document Vault RLS + grants
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md). Run AFTER migration
-- 20260620140000_documents, as the PRIVILEGED migration role.
--
-- `document` is tenant-scoped; same fail-closed predicate as the rest.
-- Relationship scoping (student / guardian / teacher / staff) is enforced in
-- DocumentsService ON TOP of this tenant isolation. Unlike financial records,
-- a wrongly-uploaded document CAN be removed, so DELETE is granted (the service
-- also deletes the storage object). Sentinel = LAST policy: document_delete.
-- =============================================================================

ALTER TABLE "document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document" FORCE  ROW LEVEL SECURITY;

CREATE POLICY document_select ON "document" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY document_insert ON "document" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY document_update ON "document" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY document_delete ON "document" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "document" TO major_user;

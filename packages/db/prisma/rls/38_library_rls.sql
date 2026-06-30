-- =============================================================================
-- library_book / book_loan RLS + grants
-- =============================================================================
-- Tenant-scoped (school_id non-null). Standard fail-closed predicate. App role
-- gets full CRUD; relationship scoping (student-self vs librarian) is enforced in
-- the service. Run as the privileged migration role. Sentinel: book_loan_delete.
-- =============================================================================

ALTER TABLE "library_book" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "library_book" FORCE  ROW LEVEL SECURITY;
CREATE POLICY library_book_select ON "library_book" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY library_book_insert ON "library_book" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY library_book_update ON "library_book" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY library_book_delete ON "library_book" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "book_loan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "book_loan" FORCE  ROW LEVEL SECURITY;
CREATE POLICY book_loan_select ON "book_loan" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY book_loan_insert ON "book_loan" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY book_loan_update ON "book_loan" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY book_loan_delete ON "book_loan" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "library_book" TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "book_loan"    TO major_user;

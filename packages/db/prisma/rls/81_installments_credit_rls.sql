-- =============================================================================
-- 81: invoice_installment + student_credit_entry — payment plans & credit.
-- =============================================================================
-- invoice_installment: operational config (staff replace a plan wholesale) —
-- full CRUD for the app role. student_credit_entry: APPEND-ONLY money ledger —
-- SELECT/INSERT only, the balance is the SUM of immutable entries.
-- Sentinel: student_credit_entry_insert.
-- =============================================================================

ALTER TABLE "invoice_installment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_installment" FORCE ROW LEVEL SECURITY;

CREATE POLICY invoice_installment_select ON "invoice_installment" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY invoice_installment_insert ON "invoice_installment" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY invoice_installment_update ON "invoice_installment" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY invoice_installment_delete ON "invoice_installment" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice_installment" TO major_user;
REVOKE TRUNCATE ON "invoice_installment" FROM major_user;

ALTER TABLE "student_credit_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "student_credit_entry" FORCE ROW LEVEL SECURITY;

CREATE POLICY student_credit_entry_select ON "student_credit_entry" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY student_credit_entry_insert ON "student_credit_entry" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT ON "student_credit_entry" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "student_credit_entry" FROM major_user;

-- =============================================================================
-- Fees / Billing RLS + grants
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md). Run AFTER migration
-- 20260620130000_fees, as the PRIVILEGED migration role.
--
-- All four tables are tenant-scoped; same fail-closed predicate as the rest.
-- Relationship scoping (parent -> children's invoices, student -> own, finance
-- staff/board -> all) is enforced in FeesService ON TOP of this tenant isolation.
--
-- Financial records are NEVER hard-deleted by the app (auditability): fee items
-- are deactivated, invoices are CANCELLED, payments stand. So no DELETE
-- policy/grant. Sentinel for the entrypoint guard = LAST policy: payment_update.
-- =============================================================================

-- A small loop: every fees table is read/write (SELECT/INSERT/UPDATE), no delete.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fee_item','invoice','invoice_line_item','payment'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %1$s_select ON %1$I FOR SELECT
      USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_insert ON %1$I FOR INSERT
      WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_update ON %1$I FOR UPDATE
      USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
      WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format('GRANT  SELECT, INSERT, UPDATE ON %I TO major_user', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE       ON %I FROM major_user', t);
  END LOOP;
END $$;

-- =============================================================================
-- Platform subscription payment RLS + grants (billing ledger; three-layer model)
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md). Run AFTER migration
-- 20260701000000_subscription_billing, as the PRIVILEGED migration role.
--
-- platform_subscription_payment is an APPEND-ONLY ledger of a school's platform
-- subscription payments — tenant-scoped (non-null schoolId), same fail-closed
-- predicate as the rest of the SMS. A school reads/inserts/updates only its OWN
-- rows (the webhook flips PENDING -> PAID under the school's GUC). No DELETE /
-- TRUNCATE — it is a financial record, like fee payments. The school_subscription
-- table itself is already RLS'd in 22_subscription_rls.sql (the new billing
-- columns are covered by its existing table-level grants). Sentinel for the
-- entrypoint guard = LAST policy created by the loop: ..._payment_update.
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_subscription_payment'] LOOP
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

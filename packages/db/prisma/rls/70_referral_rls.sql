-- =============================================================================
-- Referral program RLS + grants (three-layer model)
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md). Run AFTER migration
-- 20260828000000_referral, as the PRIVILEGED migration role.
--
-- Both tables are owned by the REFERRER school (non-null schoolId), same
-- fail-closed predicate as the rest of the SMS.
--   school_referral_code       — a school reads / creates / rotates its OWN code.
--   school_referral_conversion — APPEND-ONLY reward ledger: SELECT + INSERT
--     only. No UPDATE/DELETE/TRUNCATE — it justifies free platform time, so it
--     is a financial record like the payment ledger.
-- The referred school's own linkage lives on school_subscription (columns
-- covered by 22_subscription_rls.sql's existing table grants). Sentinel for the
-- entrypoint guard = LAST policy created: school_referral_conversion_insert.
-- =============================================================================

DO $$
BEGIN
  -- One shareable code per school: read + create + rotate, never delete.
  EXECUTE 'ALTER TABLE school_referral_code ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE school_referral_code FORCE  ROW LEVEL SECURITY';
  EXECUTE $f$CREATE POLICY school_referral_code_select ON school_referral_code FOR SELECT
    USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$;
  EXECUTE $f$CREATE POLICY school_referral_code_insert ON school_referral_code FOR INSERT
    WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$;
  EXECUTE $f$CREATE POLICY school_referral_code_update ON school_referral_code FOR UPDATE
    USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
    WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$;
  EXECUTE 'GRANT  SELECT, INSERT, UPDATE ON school_referral_code TO major_user';
  EXECUTE 'REVOKE DELETE, TRUNCATE       ON school_referral_code FROM major_user';

  -- Append-only conversion ledger.
  EXECUTE 'ALTER TABLE school_referral_conversion ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE school_referral_conversion FORCE  ROW LEVEL SECURITY';
  EXECUTE $f$CREATE POLICY school_referral_conversion_select ON school_referral_conversion FOR SELECT
    USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$;
  EXECUTE $f$CREATE POLICY school_referral_conversion_insert ON school_referral_conversion FOR INSERT
    WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$;
  EXECUTE 'GRANT  SELECT, INSERT           ON school_referral_conversion TO major_user';
  EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON school_referral_conversion FROM major_user';
END $$;

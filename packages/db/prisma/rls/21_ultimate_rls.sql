-- =============================================================================
-- Dead & Wounded Ultimate (cross-school) RLS + grants (spec §7/§10)
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md). Run AFTER migration
-- 20260628000000_ultimate, as the PRIVILEGED migration role.
--
-- This module is the ONE deliberate tenant-boundary crossing, so it has TWO
-- distinct halves with OPPOSITE isolation postures — kept explicit on purpose:
--
--  (B) TENANT-SCOPED (standard RLS): ultimate_enrollment, ultimate_consent,
--      ultimate_entry_link. Same fail-closed predicate as the rest of the SMS — a
--      school only sees/edits its OWN enrollment, consent flags, and the
--      userId<->opaque-participant bridge. So an arena row is de-anonymisable
--      ONLY within its owning school. Sentinel for the entrypoint guard = the
--      LAST policy created by the loop: ultimate_entry_link_update.
--
--  (A) CROSS-TENANT, RLS-EXEMPT (listed here EXPLICITLY, like school/role —
--      CLAUDE.md "Global (non-tenant) tables ... are explicitly marked and
--      RLS-exempt. List them; never leave it implicit"): ultimate_competition,
--      ultimate_participant. A cross-school leaderboard MUST read across schools,
--      so these have NO row policies by design. They are safe because they carry
--      NO PII — only an opaque participant id, a handle, schoolId (grouping), the
--      server-only secret (never selected into a response), and scores. The app
--      role gets SELECT/INSERT/UPDATE (writes are gated in UltimateService:
--      super_admin creates competitions; entry requires both consent tiers); no
--      DELETE (durable record of achievement).
-- =============================================================================

-- (B) Tenant-scoped half — standard RLS loop.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ultimate_enrollment','ultimate_consent','ultimate_entry_link'] LOOP
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

-- (A) Cross-tenant arena — RLS-EXEMPT BY DESIGN (no policies). The app role may
-- read/write across schools (the leaderboard is cross-school); never DELETE.
GRANT  SELECT, INSERT, UPDATE ON "ultimate_competition" TO major_user;
GRANT  SELECT, INSERT, UPDATE ON "ultimate_participant" TO major_user;
REVOKE DELETE, TRUNCATE       ON "ultimate_competition" FROM major_user;
REVOKE DELETE, TRUNCATE       ON "ultimate_participant" FROM major_user;

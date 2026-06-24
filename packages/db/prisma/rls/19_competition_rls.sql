-- =============================================================================
-- Dead & Wounded League/Knockout RLS + grants (spec §6/§10; CLAUDE.md 3-layer)
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md). Run AFTER migration
-- 20260624000000_competition, as the PRIVILEGED migration role.
--
-- Both tables are tenant-scoped (non-null schoolId); same fail-closed predicate
-- as the rest of the SMS. A school only ever sees/creates its OWN competitions
-- and standings. Relationship scoping (a teacher only their own classes/games;
-- principal/school_admin only their school) is enforced in CompetitionService ON
-- TOP of this tenant isolation; 404-not-403 for cross-tenant access.
--
-- No DELETE: competitions/standings are the durable record of a season's
-- achievement (§10); a competition is retired via status=CANCELLED (UPDATE), not
-- row deletion. Standings are recomputed via UPDATE/INSERT as matches finish.
-- Sentinel for the entrypoint guard = LAST policy created by the loop:
-- standing_update.
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['competition','standing'] LOOP
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

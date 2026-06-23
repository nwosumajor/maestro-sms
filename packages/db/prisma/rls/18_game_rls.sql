-- =============================================================================
-- Dead & Wounded game RLS + grants (platform spec §10; CLAUDE.md three-layer)
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md). Run AFTER migration
-- 20260623000000_game, as the PRIVILEGED migration role.
--
-- Every game table is tenant-scoped (non-null schoolId); same fail-closed
-- predicate as the rest of the SMS. Students only ever see/join/act on games in
-- their OWN school. Relationship scoping (a player only acts on games they're a
-- participant in) is enforced in GameService ON TOP of this tenant isolation.
--
-- No DELETE: finished games are the durable record of achievement (§10); secrets
-- are cleared via UPDATE (set null), not row deletion. Append-only `guess` is
-- never updated by the app. Sentinel for the entrypoint guard = LAST policy
-- created by the loop: game_result_update.
-- SECURITY: GamePlayer.secret is column-level server-only — RLS keeps it
-- in-tenant, and the app never selects it into any client response.
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['game','game_player','guess','game_result'] LOOP
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

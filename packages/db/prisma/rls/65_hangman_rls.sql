-- =============================================================================
-- Hangman RLS + grants (CLAUDE.md three-layer tenant isolation)
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW. Run AFTER migration 20260714010000_hangman,
-- as the PRIVILEGED migration role.
--
-- Both hangman tables are tenant-scoped (non-null schoolId) with the same
-- fail-closed predicate as the rest of the SMS. Students only ever see/join/act
-- on rounds in their OWN school. Relationship scoping (host = teacher of the
-- class; players = enrolled students; 404-not-403) is enforced in HangmanService
-- ON TOP of this tenant isolation.
--
-- No DELETE: a round's players are the durable record. SECURITY: HangmanGame.word
-- is column-level server-only WHILE LIVE — RLS keeps rows in-tenant, and the
-- service never selects the word into a client response until the round is
-- FINISHED (when the answer is revealed as the round record).
--
-- Sentinel for the entrypoint guard = LAST policy created by the loop:
-- hangman_player_update.
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hangman_game','hangman_player'] LOOP
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

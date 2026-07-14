-- =============================================================================
-- Typing Race RLS + grants (CLAUDE.md three-layer tenant isolation)
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW. Run AFTER migration 20260714030000_typing_race,
-- as the PRIVILEGED migration role.
--
-- Both typing tables are tenant-scoped (non-null schoolId) with the same
-- fail-closed predicate as the rest of the SMS. Students only ever see/join/act
-- on races in their OWN school. Relationship scoping (host = teacher of the
-- class; racers = enrolled students; 404-not-403) is enforced in
-- TypingRaceService ON TOP of this tenant isolation.
--
-- No DELETE: a race's racers are the durable record of results. (The passage is
-- not a secret — players type it — so nothing is cleared on finish.)
--
-- Sentinel for the entrypoint guard = LAST policy created by the loop:
-- typing_racer_update.
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['typing_race','typing_racer'] LOOP
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

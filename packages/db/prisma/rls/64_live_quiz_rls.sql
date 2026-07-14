-- =============================================================================
-- Live Quiz RLS + grants (CLAUDE.md three-layer tenant isolation)
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW. Run AFTER migration 20260714000000_live_quiz,
-- as the PRIVILEGED migration role.
--
-- Every live-quiz table is tenant-scoped (non-null schoolId) with the same
-- fail-closed predicate as the rest of the SMS. Students only ever see/join/act
-- on quiz sessions in their OWN school. Relationship scoping (host = teacher of
-- the class; players = enrolled students; 404-not-403) is enforced in
-- LiveQuizService ON TOP of this tenant isolation.
--
-- No DELETE: a run's participants/answers are the durable record (achievement +
-- audit); quizzes/questions are edited via UPDATE. Append-only `live_quiz_answer`
-- is never updated by the app. SECURITY: LiveQuizQuestion.answerIndex is
-- column-level server-only — RLS keeps rows in-tenant, and the service never
-- selects answerIndex into a student response while a question is live.
--
-- Sentinel for the entrypoint guard = LAST policy created by the loop:
-- live_quiz_answer_update.
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'live_quiz','live_quiz_question','live_quiz_session','live_quiz_participant','live_quiz_answer'
  ] LOOP
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

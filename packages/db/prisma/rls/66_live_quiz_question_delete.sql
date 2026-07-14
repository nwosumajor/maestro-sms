-- =============================================================================
-- Live Quiz question editability — scoped DELETE policy + grant
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW. Run AFTER 64_live_quiz_rls.sql (which enables
-- RLS + FORCE on live_quiz_question and revokes DELETE by default).
--
-- A quiz's QUESTIONS are editable authoring content (not append-only history like
-- live_quiz_answer / live_quiz_participant). Editing a quiz REPLACES its question
-- set, which needs DELETE on live_quiz_question — but only in-tenant. This adds a
-- tenant-scoped DELETE policy + grant for THAT table only; every other live-quiz
-- table stays no-DELETE. The service guards edits behind game.quiz.host + "no
-- live/lobby session for this quiz".
--
-- Sentinel for the entrypoint guard = the policy created here:
-- live_quiz_question_delete.
-- =============================================================================

CREATE POLICY live_quiz_question_delete ON live_quiz_question FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT DELETE ON live_quiz_question TO major_user;

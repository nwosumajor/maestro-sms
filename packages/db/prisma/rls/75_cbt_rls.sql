-- =============================================================================
-- 75: CBT exam hall — standard tenant isolation for all four tables.
-- =============================================================================
-- Fail-closed predicate on schoolId. Relationship scoping (teacher-authored
-- banks, student-own sittings, answerIndex redaction) is enforced in the
-- service layer; RLS is the tenant backstop. Sittings never DELETE (an exam
-- record); questions/banks/exams may be managed. Sentinel: cbt_sitting_update.
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cbt_question_bank','cbt_question','cbt_exam'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %1$s_select ON %1$I FOR SELECT
      USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_insert ON %1$I FOR INSERT
      WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_update ON %1$I FOR UPDATE
      USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
      WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_delete ON %1$I FOR DELETE
      USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO major_user', t);
    EXECUTE format('REVOKE TRUNCATE ON %I FROM major_user', t);
  END LOOP;

  -- Sittings: an exam RECORD — never hard-deleted by the app role.
  EXECUTE 'ALTER TABLE cbt_sitting ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE cbt_sitting FORCE  ROW LEVEL SECURITY';
  EXECUTE $f$CREATE POLICY cbt_sitting_select ON cbt_sitting FOR SELECT
    USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$;
  EXECUTE $f$CREATE POLICY cbt_sitting_insert ON cbt_sitting FOR INSERT
    WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$;
  EXECUTE $f$CREATE POLICY cbt_sitting_update ON cbt_sitting FOR UPDATE
    USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
    WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$;
  EXECUTE 'GRANT  SELECT, INSERT, UPDATE ON cbt_sitting TO major_user';
  EXECUTE 'REVOKE DELETE, TRUNCATE       ON cbt_sitting FROM major_user';
END $$;

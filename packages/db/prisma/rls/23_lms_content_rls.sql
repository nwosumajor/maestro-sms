-- =============================================================================
-- LMS learning content RLS + grants (CLAUDE.md three-layer)
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md). Run AFTER migration
-- 20260630000000_lms_content, as the PRIVILEGED migration role.
--
-- Three tenant-scoped tables (non-null schoolId), same fail-closed predicate as
-- the rest of the SMS. RLS enforces TENANT isolation; the relationship/approval
-- scoping (teacher-of-class authoring, enrolled-student PUBLISHED-only reads,
-- principal approval) is layered in LmsContentService on top. The app role may
-- read/insert/update; forum posts + quiz attempts are append-only from the app's
-- perspective (no row deletes by the app — staff moderation is an UPDATE/soft
-- path; hard deletes happen only under the privileged role). Sentinel for the
-- entrypoint guard = LAST policy created by the loop: forum_post_update.
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lms_content','quiz_attempt','forum_post'] LOOP
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

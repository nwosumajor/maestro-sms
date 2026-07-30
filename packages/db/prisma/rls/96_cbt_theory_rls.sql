-- =============================================================================
-- cbt_theory_answer RLS + grants
-- =============================================================================
-- A candidate's open-response answer plus the mark a human awarded. Tenant-scoped
-- (school_id non-null); standard fail-closed predicate. The app role may SELECT,
-- INSERT and UPDATE — a candidate autosaves their own answer (upserted while the
-- sitting is IN_PROGRESS) and a marker later writes the mark onto the same row.
--
-- DELETE is REVOKED: an answer sat in an exam, and the mark awarded to it, are
-- assessment records. They are never removed, only superseded by a re-mark (which
-- overwrites marksAwarded and re-stamps markedById/markedAt, leaving the audit log
-- as the history). Sentinel: cbt_theory_answer_update.
-- =============================================================================

ALTER TABLE "cbt_theory_answer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cbt_theory_answer" FORCE  ROW LEVEL SECURITY;

CREATE POLICY cbt_theory_answer_select ON "cbt_theory_answer" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY cbt_theory_answer_insert ON "cbt_theory_answer" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY cbt_theory_answer_update ON "cbt_theory_answer" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "cbt_theory_answer" TO major_user;
REVOKE DELETE, TRUNCATE       ON "cbt_theory_answer" FROM major_user;

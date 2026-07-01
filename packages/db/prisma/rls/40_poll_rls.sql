-- =============================================================================
-- poll / poll_option / poll_vote RLS + grants
-- =============================================================================
-- Tenant-scoped (school_id non-null). Standard fail-closed predicate. App role
-- gets full CRUD; anonymity (never exposing voterId↔optionId) is enforced in the
-- service, not the DB. Run as the privileged migration role. Sentinel:
-- poll_vote_delete.
-- =============================================================================

ALTER TABLE "poll" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "poll" FORCE  ROW LEVEL SECURITY;
CREATE POLICY poll_select ON "poll" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY poll_insert ON "poll" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY poll_update ON "poll" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY poll_delete ON "poll" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "poll_option" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "poll_option" FORCE  ROW LEVEL SECURITY;
CREATE POLICY poll_option_select ON "poll_option" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY poll_option_insert ON "poll_option" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY poll_option_update ON "poll_option" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY poll_option_delete ON "poll_option" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

ALTER TABLE "poll_vote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "poll_vote" FORCE  ROW LEVEL SECURITY;
CREATE POLICY poll_vote_select ON "poll_vote" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY poll_vote_insert ON "poll_vote" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY poll_vote_update ON "poll_vote" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY poll_vote_delete ON "poll_vote" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "poll"        TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "poll_option" TO major_user;
GRANT SELECT, INSERT                 ON "poll_vote"   TO major_user;

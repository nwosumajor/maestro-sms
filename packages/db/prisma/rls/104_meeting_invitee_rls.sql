-- Meeting invitees: ordinary tenant data. The GRANT is as load-bearing as the
-- policies — RLS confines WHICH rows, the GRANT decides which verbs exist at
-- all, and without it every query is a bare 42501.
GRANT SELECT, INSERT, DELETE ON "meeting_invitee" TO major_user;

ALTER TABLE "meeting_invitee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_invitee" FORCE ROW LEVEL SECURITY;

CREATE POLICY meeting_invitee_select ON "meeting_invitee" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id')::uuid);
CREATE POLICY meeting_invitee_insert ON "meeting_invitee" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id')::uuid);
CREATE POLICY meeting_invitee_delete ON "meeting_invitee" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id')::uuid);

-- Meeting co-hosts: ordinary tenant data. The GRANT is as load-bearing as the
-- policies — without it every query is a bare 42501 whatever they say.
GRANT SELECT, INSERT, DELETE ON "meeting_cohost" TO major_user;

ALTER TABLE "meeting_cohost" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_cohost" FORCE ROW LEVEL SECURITY;

CREATE POLICY meeting_cohost_select ON "meeting_cohost" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id')::uuid);
CREATE POLICY meeting_cohost_insert ON "meeting_cohost" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id')::uuid);
CREATE POLICY meeting_cohost_delete ON "meeting_cohost" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id')::uuid);

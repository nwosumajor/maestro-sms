-- Tenant isolation for meeting_request.
--
-- A request names a child, a parent and a teacher — the whole row is about
-- identifiable minors' family contact, so it never leaves its school.
--
-- No DELETE policy: a request is a record of an ask and its answer. Withdrawing
-- one is a status change (CANCELLED), not a disappearance — otherwise a parent
-- could unask a concern and leave nothing behind.

ALTER TABLE "meeting_request" ENABLE ROW LEVEL SECURITY;
-- FORCE matters as much as ENABLE: without it the table OWNER bypasses every
-- policy, and migrations and seeds run as exactly that owner.
ALTER TABLE "meeting_request" FORCE ROW LEVEL SECURITY;

CREATE POLICY meeting_request_select ON "meeting_request"
  FOR SELECT USING ("schoolId" = current_setting('app.current_school_id')::uuid);

CREATE POLICY meeting_request_insert ON "meeting_request"
  FOR INSERT WITH CHECK ("schoolId" = current_setting('app.current_school_id')::uuid);

CREATE POLICY meeting_request_update ON "meeting_request"
  FOR UPDATE USING ("schoolId" = current_setting('app.current_school_id')::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id')::uuid);

-- Policies alone are not access: without the GRANT the app role gets 42501.
GRANT SELECT, INSERT, UPDATE ON "meeting_request" TO major_user;

-- =============================================================================
-- Messaging + Calendar RLS + grants
-- =============================================================================
-- Run AFTER migration 20260620200000_messaging_events, as the PRIVILEGED role.
-- All tenant-scoped; participant scoping is enforced in MessagingService. Messages
-- are append-only (SELECT/INSERT). Sentinel = LAST policy: school_event_delete.
-- =============================================================================

-- threads + participants: read/write (participants update lastReadAt)
ALTER TABLE "message_thread" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_thread" FORCE  ROW LEVEL SECURITY;
CREATE POLICY message_thread_select ON "message_thread" FOR SELECT USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY message_thread_insert ON "message_thread" FOR INSERT WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY message_thread_update ON "message_thread" FOR UPDATE USING ("schoolId" = current_setting('app.current_school_id', true)::uuid) WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "message_thread" TO major_user;

ALTER TABLE "thread_participant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "thread_participant" FORCE  ROW LEVEL SECURITY;
CREATE POLICY thread_participant_select ON "thread_participant" FOR SELECT USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY thread_participant_insert ON "thread_participant" FOR INSERT WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY thread_participant_update ON "thread_participant" FOR UPDATE USING ("schoolId" = current_setting('app.current_school_id', true)::uuid) WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "thread_participant" TO major_user;

-- messages: append-only (no update/delete)
ALTER TABLE "message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message" FORCE  ROW LEVEL SECURITY;
CREATE POLICY message_select ON "message" FOR SELECT USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY message_insert ON "message" FOR INSERT WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT  SELECT, INSERT           ON "message" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "message" FROM major_user;

-- events: read/write incl. delete (events get cancelled)
ALTER TABLE "school_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "school_event" FORCE  ROW LEVEL SECURITY;
CREATE POLICY school_event_select ON "school_event" FOR SELECT USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY school_event_insert ON "school_event" FOR INSERT WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY school_event_update ON "school_event" FOR UPDATE USING ("schoolId" = current_setting('app.current_school_id', true)::uuid) WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY school_event_delete ON "school_event" FOR DELETE USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "school_event" TO major_user;

-- =============================================================================
-- 86: meeting_slot + meeting_booking — parent-teacher appointments.
-- =============================================================================
-- Standard tenant RLS, full CRUD for the app role. Relationship scoping (who
-- may open a slot / book / cancel) is in MeetingService.
-- Sentinel: meeting_booking_delete.
-- =============================================================================

ALTER TABLE "meeting_slot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_slot" FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_slot_select ON "meeting_slot" FOR SELECT USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY meeting_slot_insert ON "meeting_slot" FOR INSERT WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY meeting_slot_update ON "meeting_slot" FOR UPDATE USING ("schoolId" = current_setting('app.current_school_id', true)::uuid) WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY meeting_slot_delete ON "meeting_slot" FOR DELETE USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "meeting_slot" TO major_user;
REVOKE TRUNCATE ON "meeting_slot" FROM major_user;

ALTER TABLE "meeting_booking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_booking" FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_booking_select ON "meeting_booking" FOR SELECT USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY meeting_booking_insert ON "meeting_booking" FOR INSERT WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY meeting_booking_update ON "meeting_booking" FOR UPDATE USING ("schoolId" = current_setting('app.current_school_id', true)::uuid) WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY meeting_booking_delete ON "meeting_booking" FOR DELETE USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "meeting_booking" TO major_user;
REVOKE TRUNCATE ON "meeting_booking" FROM major_user;

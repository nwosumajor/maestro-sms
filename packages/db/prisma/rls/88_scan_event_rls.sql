-- scan_event — append-only movement log. SELECT + INSERT only (a scan is a fact).
ALTER TABLE "scan_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scan_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY scan_event_select ON "scan_event" FOR SELECT USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY scan_event_insert ON "scan_event" FOR INSERT WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
GRANT SELECT, INSERT ON "scan_event" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "scan_event" FROM major_user;

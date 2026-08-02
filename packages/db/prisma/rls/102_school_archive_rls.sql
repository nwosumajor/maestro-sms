-- =============================================================================
-- school_archive — the long-term retrieval artifact
-- =============================================================================
-- Standard tenant isolation, with one deliberate difference: NO DELETE and NO
-- UPDATE for the app role.
--
-- These exist so that a question asked in ten years can be answered, and their
-- evidential value rests entirely on nobody having been able to quietly alter or
-- remove one. A row records a checksum of the stored bytes; letting the app
-- rewrite that row would make the checksum meaningless. Removing an archive is
-- therefore an out-of-band act by a privileged operator, not something the
-- application can do at all.
-- =============================================================================

ALTER TABLE school_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_archive FORCE ROW LEVEL SECURITY;

CREATE POLICY school_archive_select ON school_archive
  FOR SELECT USING ("schoolId" = current_setting('app.current_school_id')::uuid);

CREATE POLICY school_archive_insert ON school_archive
  FOR INSERT WITH CHECK ("schoolId" = current_setting('app.current_school_id')::uuid);

GRANT SELECT, INSERT ON school_archive TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON school_archive FROM major_user;

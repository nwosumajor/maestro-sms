-- =============================================================================
-- Timetabling RLS + grants
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md). Run AFTER migration
-- 20260620150000_timetable, as the PRIVILEGED migration role.
--
-- All three tables are tenant-scoped read/write; same fail-closed predicate as
-- the rest. Relationship scoping (teacher -> own lessons, student -> enrolled
-- class, parent -> children, staff -> all) is enforced in TimetableService ON
-- TOP of this tenant isolation. Entries are moved/removed and periods/rooms are
-- edited, so DELETE is granted. Sentinel for the entrypoint guard = the LAST
-- policy created: timetable_entry_delete.
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['period','room','timetable_entry'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %1$s_select ON %1$I FOR SELECT
      USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_insert ON %1$I FOR INSERT
      WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_update ON %1$I FOR UPDATE
      USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
      WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_delete ON %1$I FOR DELETE
      USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO major_user', t);
  END LOOP;
END $$;

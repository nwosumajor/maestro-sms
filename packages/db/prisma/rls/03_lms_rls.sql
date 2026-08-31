-- =============================================================================
-- LMS RLS + grants
-- =============================================================================
-- All four tables are tenant-scoped read/write. Same fail-closed predicate the
-- rest of the system uses: a missing app.current_school_id GUC yields NULL and
-- matches no rows. Run as the privileged migration role. Adjust `major_user` if
-- the app role differs.
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  -- `class_teacher` was DROPPED by migration 20270118000000: a class teacher IS
  -- the class supervisor, one column on `class`, and the join table that
  -- shadowed it is gone.
  --
  -- IT HAD TO COME OUT OF HERE TOO. This file is one DO block looping the array
  -- IN ORDER under ON_ERROR_STOP, so on a FRESH database it died on the missing
  -- relation and `enrollment` and `parent_child` — everything after it — got
  -- neither policies nor grants. An existing database was unaffected, because
  -- the file had applied years earlier when the table still existed, which is
  -- exactly why nobody met it: only a NEW deployment breaks, and it breaks
  -- loudly (the app role cannot read `enrollment` at all).
  FOREACH t IN ARRAY ARRAY['class','enrollment','parent_child'] LOOP
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

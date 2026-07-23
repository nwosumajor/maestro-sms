-- =============================================================================
-- Academic calendar (academic_session + term) RLS + grants
-- =============================================================================
-- Both tenant-scoped read/write. Same fail-closed predicate the rest of the
-- system uses. Run as the privileged migration role. Sentinel (entrypoint
-- idempotency key): the LAST policy created, term_delete.
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['academic_session','term'] LOOP
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

-- Single "current" per school — enforced at the DB, not just the app. Many
-- features resolve the isCurrent term/session (attendance term-lock, assessment
-- term tagging, report-card term default); two current rows would make those
-- nondeterministic. setCurrentTerm/Session clear the old before setting the new,
-- so the invariant holds at every statement boundary; this makes a stray direct
-- write or a future missed-clear fail loudly instead of corrupting silently.
-- Partial index (WHERE isCurrent) — not expressible in the Prisma schema.
CREATE UNIQUE INDEX IF NOT EXISTS "term_one_current_per_school"
  ON "term" ("schoolId") WHERE "isCurrent";
CREATE UNIQUE INDEX IF NOT EXISTS "academic_session_one_current_per_school"
  ON "academic_session" ("schoolId") WHERE "isCurrent";

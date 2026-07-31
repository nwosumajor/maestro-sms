-- =============================================================================
-- 98: attendance_term_rollup — precomputed per-term attendance totals
-- =============================================================================
-- Tenant-scoped like the registers it summarises. Full CRUD for the app role,
-- because unlike the append-only ledgers this is DERIVED data: recomputing a term
-- must be able to replace its rows outright, and a rollup row carries no fact that
-- the source records do not already hold.
--
-- That is also why UPDATE and DELETE are safe here and are not elsewhere: deleting
-- a rollup row destroys nothing — it can be rebuilt from attendance_record. The
-- registers themselves remain correction-only with no delete path (rls/04).
--
-- Sentinel: attendance_term_rollup_delete.
-- =============================================================================

ALTER TABLE "attendance_term_rollup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_term_rollup" FORCE  ROW LEVEL SECURITY;

CREATE POLICY attendance_term_rollup_select ON "attendance_term_rollup" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY attendance_term_rollup_insert ON "attendance_term_rollup" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY attendance_term_rollup_update ON "attendance_term_rollup" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY attendance_term_rollup_delete ON "attendance_term_rollup" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE, DELETE ON "attendance_term_rollup" TO major_user;
REVOKE TRUNCATE                       ON "attendance_term_rollup" FROM major_user;

-- =============================================================================
-- promotion_batch RLS + grants
-- =============================================================================
-- Tenant-scoped. SELECT/INSERT/UPDATE only (no DELETE) — the staged batch + its
-- maker-checker decision are retained as a trail. Same fail-closed predicate the
-- rest of the system uses. Run as the privileged migration role. Sentinel:
-- promotion_batch_update (the last policy created).
-- =============================================================================

ALTER TABLE "promotion_batch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotion_batch" FORCE  ROW LEVEL SECURITY;

CREATE POLICY promotion_batch_select ON "promotion_batch" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY promotion_batch_insert ON "promotion_batch" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY promotion_batch_update ON "promotion_batch" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "promotion_batch" TO major_user;
REVOKE DELETE, TRUNCATE       ON "promotion_batch" FROM major_user;

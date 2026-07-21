-- =============================================================================
-- 82: invoice_adjustment — maker-checker discounts/waivers.
-- =============================================================================
-- Standard tenant RLS. Financial history: SELECT/INSERT/UPDATE only — an
-- adjustment is decided (APPROVED/REJECTED), never erased.
-- Sentinel: invoice_adjustment_update.
-- =============================================================================

ALTER TABLE "invoice_adjustment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_adjustment" FORCE ROW LEVEL SECURITY;

CREATE POLICY invoice_adjustment_select ON "invoice_adjustment" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY invoice_adjustment_insert ON "invoice_adjustment" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY invoice_adjustment_update ON "invoice_adjustment" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON "invoice_adjustment" TO major_user;
REVOKE DELETE, TRUNCATE ON "invoice_adjustment" FROM major_user;

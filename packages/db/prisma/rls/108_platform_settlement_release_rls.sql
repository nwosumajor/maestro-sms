-- =============================================================================
-- 108: platform_settlement_release — the platform paying a school what it holds
-- =============================================================================
-- Tenant-scoped and owned by the SCHOOL the money belongs to, so a school reads
-- its own release history through the ordinary tenant client and can reconcile
-- it against its bank. The releases are CREATED by the platform operator, whose
-- own write runs with the GUC set to the target school — the same pattern as the
-- message-credit comp lever.
--
-- APPEND-ONLY, like every financial record here. A release states that money
-- left the platform's bank on a date with a reference; editing one afterwards
-- would make the ledger disagree with the bank, and a mistake is corrected by a
-- further release rather than by rewriting this one. No UPDATE, no DELETE.
--
-- Sentinel: platform_settlement_release_insert.
-- =============================================================================

ALTER TABLE "platform_settlement_release" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_settlement_release" FORCE  ROW LEVEL SECURITY;

CREATE POLICY platform_settlement_release_select ON "platform_settlement_release" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY platform_settlement_release_insert ON "platform_settlement_release" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT ON "platform_settlement_release" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "platform_settlement_release" FROM major_user;

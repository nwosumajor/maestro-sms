-- =============================================================================
-- 99: platform_delegation — owner-granted, time-bound platform duties
-- =============================================================================
-- Tenant-scoped like everything else, to the PLATFORM org. That is the point of
-- storing it this way rather than as a global table: the operator's own JWT carries
-- the platform org's school_id, so the ordinary policy already confines it, and no
-- deny-all special case has to be reasoned about separately.
--
-- No DELETE for the app role. A delegation is the record of who could do what and
-- when — the answer to "who had access on the day that happened" — so a hand-back
-- sets revokedAt rather than removing the row. Same posture as the financial and
-- audit ledgers.
--
-- Sentinel: platform_delegation_update.
-- =============================================================================

ALTER TABLE "platform_delegation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_delegation" FORCE  ROW LEVEL SECURITY;

CREATE POLICY platform_delegation_select ON "platform_delegation" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY platform_delegation_insert ON "platform_delegation" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
-- UPDATE exists solely so a live delegation can be handed back (revokedAt).
CREATE POLICY platform_delegation_update ON "platform_delegation" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "platform_delegation" TO major_user;
REVOKE DELETE, TRUNCATE       ON "platform_delegation" FROM major_user;

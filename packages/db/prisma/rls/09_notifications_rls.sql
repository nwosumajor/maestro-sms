-- =============================================================================
-- Notifications RLS + grants
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md). Run AFTER migration
-- 20260620120000_notifications, as the PRIVILEGED migration role.
--
-- Both tables are tenant-scoped; same fail-closed predicate as the rest. The
-- recipient self-scoping (a user reads only their OWN inbox) is enforced in
-- NotificationService ON TOP of this tenant isolation. The async delivery worker
-- runs as the app role inside a tenant transaction and UPDATEs delivery status.
-- Notifications are not deleted by the app (retention is a separate concern):
-- no DELETE policy/grant. Sentinel = LAST policy: notification_delivery_update.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- notification  (read/write; readAt receipt via UPDATE; no delete)
-- -----------------------------------------------------------------------------
ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification" FORCE  ROW LEVEL SECURITY;

CREATE POLICY notification_select ON "notification" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY notification_insert ON "notification" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY notification_update ON "notification" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "notification" TO major_user;
REVOKE DELETE, TRUNCATE       ON "notification" FROM major_user;

-- -----------------------------------------------------------------------------
-- notification_delivery  (read/write; worker updates status; no delete)
-- -----------------------------------------------------------------------------
ALTER TABLE "notification_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_delivery" FORCE  ROW LEVEL SECURITY;

CREATE POLICY notification_delivery_select ON "notification_delivery" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY notification_delivery_insert ON "notification_delivery" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY notification_delivery_update ON "notification_delivery" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "notification_delivery" TO major_user;
REVOKE DELETE, TRUNCATE       ON "notification_delivery" FROM major_user;

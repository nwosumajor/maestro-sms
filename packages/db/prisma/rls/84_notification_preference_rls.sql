-- =============================================================================
-- 84: notification_preference — per-user external-channel delivery prefs.
-- =============================================================================
-- Standard tenant RLS, full CRUD for the app role; the SERVICE narrows every
-- read/write to the caller's OWN userId (self-service only). The delivery
-- producer reads a recipient's row in the recipient's tenant context.
-- Sentinel: notification_preference_delete.
-- =============================================================================

ALTER TABLE "notification_preference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_preference" FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_preference_select ON "notification_preference" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY notification_preference_insert ON "notification_preference" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY notification_preference_update ON "notification_preference" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY notification_preference_delete ON "notification_preference" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_preference" TO major_user;
REVOKE TRUNCATE ON "notification_preference" FROM major_user;

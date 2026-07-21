-- =============================================================================
-- 79: gateway_event — append-only verified-webhook log (both gateways).
-- =============================================================================
-- INSERT: WITH CHECK (true) — the webhook writes BEFORE tenant resolution,
-- with no GUC set (system context; tenants have no API that inserts here).
-- SELECT: tenant-scoped — a school can see only its OWN resolved events;
-- null-school rows are invisible to every tenant (payloads may reference other
-- tenants' charges). No UPDATE/DELETE at all: the log is immutable evidence.
-- Sentinel: gateway_event_insert.
-- =============================================================================

ALTER TABLE "gateway_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gateway_event" FORCE ROW LEVEL SECURITY;

CREATE POLICY gateway_event_select ON "gateway_event" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY gateway_event_insert ON "gateway_event" FOR INSERT
  WITH CHECK (true);

GRANT SELECT, INSERT ON "gateway_event" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "gateway_event" FROM major_user;

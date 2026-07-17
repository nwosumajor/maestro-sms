-- =============================================================================
-- 73: message_credit_entry — append-only per-school message-credit ledger.
-- =============================================================================
-- Tenant-scoped (non-null schoolId), standard fail-closed predicate. SELECT +
-- INSERT only: purchases and debits append; nothing is ever edited or deleted
-- (it justifies paid credits, like the payment ledgers). Sentinel policy:
-- message_credit_entry_insert.
-- =============================================================================

ALTER TABLE "message_credit_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_credit_entry" FORCE ROW LEVEL SECURITY;

CREATE POLICY message_credit_entry_select ON "message_credit_entry" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY message_credit_entry_insert ON "message_credit_entry" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT           ON "message_credit_entry" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "message_credit_entry" FROM major_user;

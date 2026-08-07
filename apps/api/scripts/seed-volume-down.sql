-- =============================================================================
-- seed-volume-down.sql — remove everything seed-volume.sql created
-- =============================================================================
-- Deletes CHILD rows before parents; a FK violation here means the delete order
-- is wrong, not that the data is stuck.
--
-- Everything is matched on the tags the up-script wrote:
--   'vol.s%@demo.school' / 'vol.t%@demo.school'   users
--   'VOL %'                                       classes
--   'VOL-%' / 'VOLPAY-%'                          invoices / payments
-- so it can never touch a real row, and it is safe to run twice.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE doomed_user AS
SELECT id FROM "user" WHERE email LIKE 'vol.s%@demo.school' OR email LIKE 'vol.t%@demo.school';
CREATE TEMP TABLE doomed_class AS SELECT id FROM class WHERE name LIKE 'VOL %';

DELETE FROM payment WHERE reference LIKE 'VOLPAY-%';
-- Line items before their invoice, and the catalog rows they point at last.
DELETE FROM invoice_line_item WHERE "invoiceId" IN (SELECT id FROM invoice WHERE reference LIKE 'VOL-%');
DELETE FROM invoice WHERE reference LIKE 'VOL-%';
DELETE FROM fee_item WHERE name LIKE 'VOL %';
DELETE FROM notification WHERE "recipientId" IN (SELECT id FROM doomed_user);
DELETE FROM attendance_record WHERE "sessionId" IN
  (SELECT id FROM attendance_session WHERE "classId" IN (SELECT id FROM doomed_class));
DELETE FROM attendance_session WHERE "classId" IN (SELECT id FROM doomed_class);
DELETE FROM enrollment WHERE "classId" IN (SELECT id FROM doomed_class);
DELETE FROM user_role WHERE "userId" IN (SELECT id FROM doomed_user);
-- audit_log.actorId references "user" — these rows must go BEFORE their actors.
DELETE FROM audit_log WHERE "actorId" IN (SELECT id FROM doomed_user);
DELETE FROM class WHERE id IN (SELECT id FROM doomed_class);
DELETE FROM "user" WHERE id IN (SELECT id FROM doomed_user);

COMMIT;
ANALYZE;

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
--   (profiles/contacts/medical are matched via their OWNING user, not a tag)
-- so it can never touch a real row, and it is safe to run twice.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE doomed_user AS
SELECT id FROM "user" WHERE email LIKE 'vol.s%@demo.school' OR email LIKE 'vol.t%@demo.school';
CREATE TEMP TABLE doomed_class AS SELECT id FROM class WHERE name LIKE 'VOL %';

-- EVERY child of a doomed invoice, matched BY INVOICE rather than by the tag
-- the up-script happened to write on it.
--
-- This deleted `payment WHERE reference LIKE 'VOLPAY-%'` — only the payments
-- the seed itself created. Any payment recorded against a VOL invoice THROUGH
-- THE APP (demoing "record a payment", or an approval test) carries a generated
-- reference instead, so it survived and the invoice delete then died on
-- payment_invoiceId_fkey. Four of the five children are ON DELETE RESTRICT, so
-- each has to go explicitly; invoice_line_item cascades but is listed anyway
-- because relying on a cascade that a later migration might change is how this
-- breaks again quietly.
CREATE TEMP TABLE doomed_invoice AS SELECT id FROM invoice WHERE reference LIKE 'VOL-%';

DELETE FROM payment              WHERE "invoiceId" IN (SELECT id FROM doomed_invoice);
DELETE FROM invoice_adjustment   WHERE "invoiceId" IN (SELECT id FROM doomed_invoice);
DELETE FROM invoice_installment  WHERE "invoiceId" IN (SELECT id FROM doomed_invoice);
DELETE FROM mobile_money_intent  WHERE "invoiceId" IN (SELECT id FROM doomed_invoice);
DELETE FROM invoice_line_item    WHERE "invoiceId" IN (SELECT id FROM doomed_invoice);
DELETE FROM invoice              WHERE id IN (SELECT id FROM doomed_invoice);
DELETE FROM fee_item WHERE name LIKE 'VOL %';
DELETE FROM notification WHERE "recipientId" IN (SELECT id FROM doomed_user);
-- SIS: medical + contacts hang off the PROFILE, so all three go in that order
-- (and before the users the profiles point at).
DELETE FROM medical_record WHERE "profileId" IN
  (SELECT id FROM student_profile WHERE "studentId" IN (SELECT id FROM doomed_user));
DELETE FROM emergency_contact WHERE "profileId" IN
  (SELECT id FROM student_profile WHERE "studentId" IN (SELECT id FROM doomed_user));
DELETE FROM student_profile WHERE "studentId" IN (SELECT id FROM doomed_user);
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

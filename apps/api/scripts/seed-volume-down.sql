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
--   'VOL %'                                       subjects / assessments
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
-- ACADEMICS, child-before-parent: a grade hangs off a submission, a submission
-- off an assessment; subject results and offerings both point at the subjects.
-- All of it must go before the classes and users they reference.
DELETE FROM grade WHERE "submissionId" IN
  (SELECT s.id FROM submission s JOIN assessment a ON a.id = s."assessmentId" WHERE a.title LIKE 'VOL %');
DELETE FROM submission WHERE "assessmentId" IN (SELECT id FROM assessment WHERE title LIKE 'VOL %');
DELETE FROM assessment WHERE title LIKE 'VOL %';
DELETE FROM subject_result WHERE "subjectId" IN (SELECT id FROM subject WHERE name LIKE 'VOL %');
DELETE FROM class_subject_teacher WHERE "subjectId" IN (SELECT id FROM subject WHERE name LIKE 'VOL %');
DELETE FROM subject WHERE name LIKE 'VOL %';

DELETE FROM attendance_record WHERE "sessionId" IN
  (SELECT id FROM attendance_session WHERE "classId" IN (SELECT id FROM doomed_class));
DELETE FROM attendance_session WHERE "classId" IN (SELECT id FROM doomed_class);
DELETE FROM enrollment WHERE "classId" IN (SELECT id FROM doomed_class);
DELETE FROM user_role WHERE "userId" IN (SELECT id FROM doomed_user);
-- audit_log.actorId references "user" — these rows must go BEFORE their actors.
DELETE FROM audit_log WHERE "actorId" IN (SELECT id FROM doomed_user);
-- ANYTHING ELSE THE APP ATTACHED TO A SEEDED USER.
--
-- The explicit deletes above cover what the SEED writes. They cannot cover what
-- the APPLICATION writes while the seeded school is being used, and that has
-- broken this script twice: a payment recorded against a VOL invoice, and a
-- report-card PDF filed in the document vault for a VOL pupil. Each time the
-- failure was a foreign key at the very end, after minutes of deleting.
--
-- So the last step is generic: walk every FK that points at "user" and remove
-- the rows belonging to a doomed one. Repeated passes let a child-of-a-child go
-- after its parent; it stops as soon as a pass deletes nothing, and RAISES what
-- it removed rather than cleaning up silently — a table showing up here means
-- the section above has a gap worth naming.
DO $$
DECLARE
  r record;
  removed bigint;
  pass int := 0;
  total_this_pass bigint;
BEGIN
  LOOP
    pass := pass + 1;
    total_this_pass := 0;
    FOR r IN
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = '"user"'::regclass
    LOOP
      BEGIN
        EXECUTE format(
          'DELETE FROM %s WHERE %I IN (SELECT id FROM doomed_user)', r.tbl, r.col);
        GET DIAGNOSTICS removed = ROW_COUNT;
        IF removed > 0 THEN
          total_this_pass := total_this_pass + removed;
          RAISE NOTICE 'swept % row(s) from %.%', removed, r.tbl, r.col;
        END IF;
      EXCEPTION WHEN foreign_key_violation THEN
        -- Something still points at these rows; a later pass gets them.
        NULL;
      END;
    END LOOP;
    EXIT WHEN total_this_pass = 0 OR pass >= 5;
  END LOOP;
END $$;

DELETE FROM class WHERE id IN (SELECT id FROM doomed_class);
DELETE FROM "user" WHERE id IN (SELECT id FROM doomed_user);

COMMIT;
ANALYZE;

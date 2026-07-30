-- =============================================================================
-- Golden Rule #1 at the SCHEMA level: every tenant table gets a real FK to school
-- =============================================================================
-- All 176 tenant-scoped tables carry a non-null "schoolId", but only 105 had a
-- FOREIGN KEY to "school". For the other 71, nothing at the DB level stopped a row
-- outliving the school it names. Those orphans were never a security leak — no live
-- tenant can match a schoolId that no longer exists, so RLS hides them from
-- everyone — but they were permanent, uncountable debris that tenant-scoped code
-- can never see to clean up. An audit found 115 in the live DB and 530 in the test
-- DB, all left by teardowns that deleted a school without clearing its children.
--
-- ON DELETE RESTRICT matches the convention all 105 existing FKs already use, and
-- it is the right posture here: a school must not be erasable while it still owns
-- rows. That keeps tenant offboarding an explicit, ordered, audited procedure
-- instead of one statement that silently vaporises a customer's financial ledger
-- and audit trail. The product lever for ending a tenancy is DISABLE, not DELETE;
-- the app role holds SELECT-only on "school" and no code path deletes one, so this
-- constraint closes the last remaining route by which an orphan could appear.
--
-- SAFETY: this migration must not be able to FAIL. A failed migration blocks every
-- later one and takes the API down on boot (learned the hard way in PR #21). Two
-- guards:
--   1. Orphans are cleared FIRST, in repeated passes with per-table exception
--      handling, so inter-table FK ordering resolves itself instead of aborting.
--   2. Each constraint is added only if absent, so re-running is a no-op.
-- =============================================================================

DO $$
DECLARE
  t          text;
  removed    int;
  pass_total int;
  pass       int := 0;
  -- The 71 tenant tables that lacked the constraint.
  tbls       text[] := ARRAY[
    'agent_commission', 'alumnus', 'applicant', 'appraisal', 'attendance_device',
    'attendance_kiosk', 'biometric_enrollment', 'book_loan', 'disciplinary_case',
    'disciplinary_entry', 'discipline_assignee', 'discipline_complaint',
    'discipline_entry', 'discipline_evidence', 'discussion_comment',
    'discussion_group', 'discussion_post', 'duty_assignment',
    'employment_change_request', 'form', 'form_response', 'gateway_event',
    'hostel', 'hostel_allocation', 'hostel_attendance', 'hostel_exeat',
    'hostel_incident', 'hostel_room', 'issued_certificate', 'job_requisition',
    'leave_balance', 'leave_request', 'leave_type', 'library_book', 'lms_award',
    'lms_content_revision', 'lms_live_attendance', 'lms_live_session',
    'lms_module', 'lms_progress', 'lms_submission', 'loan_repayment',
    'pay_component', 'payroll_run', 'payslip', 'platform_feedback_message',
    'poll', 'poll_option', 'poll_vote', 'route_stop', 'salary_change_request',
    'school_branding', 'school_group_member', 'staff_attendance',
    'staff_checklist', 'staff_checklist_item', 'staff_document', 'staff_exit',
    'staff_loan', 'task', 'task_assignment', 'task_comment', 'training_record',
    'transport_assignment', 'transport_boarding', 'transport_route',
    'transport_trip', 'vehicle', 'vehicle_location', 'vehicle_maintenance',
    'xapi_statement'
  ];
BEGIN
  -- ---------------------------------------------------------------------------
  -- 1. Clear unreachable orphans.
  --    Several of these tables reference EACH OTHER (lms_content_revision ->
  --    lms_content, poll_vote -> poll_option, task_comment -> task), so a parent's
  --    orphan cannot be removed before its child's. Rather than hard-code a
  --    topological order that would silently rot as tables are added, retry until
  --    a pass removes nothing. Nesting is shallow so this converges in 2-3 passes;
  --    the cap is a runaway backstop, not an expected limit.
  -- ---------------------------------------------------------------------------
  LOOP
    pass := pass + 1;
    pass_total := 0;
    FOREACH t IN ARRAY tbls LOOP
      BEGIN
        EXECUTE format(
          'DELETE FROM %I x WHERE x."schoolId" IS NOT NULL AND NOT EXISTS '
          '(SELECT 1 FROM school s WHERE s.id = x."schoolId")', t);
        GET DIAGNOSTICS removed = ROW_COUNT;
        pass_total := pass_total + removed;
        IF removed > 0 THEN
          RAISE NOTICE 'cleared % orphan row(s) from %', removed, t;
        END IF;
      EXCEPTION WHEN foreign_key_violation THEN
        -- A child still holds a reference; a later pass will reach it.
        NULL;
      END;
    END LOOP;
    EXIT WHEN pass_total = 0 OR pass >= 6;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- 2. Add the constraint where it is missing. Postgres has no
  --    "ADD CONSTRAINT IF NOT EXISTS", so check pg_constraint explicitly.
  --
  --    gateway_event is the ONE table taking SET NULL rather than RESTRICT: its
  --    "schoolId" is nullable BY DESIGN, because a verified gateway webhook must be
  --    durably recorded before its tenant is resolved. That log is an append-only
  --    record of what the gateway actually sent, so it has to survive independently
  --    of tenant lifecycle.
  -- ---------------------------------------------------------------------------
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = t || '_schoolId_fkey'
        AND conrelid = format('%I', t)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("schoolId") '
        'REFERENCES "school"("id") ON DELETE %s ON UPDATE CASCADE',
        t, t || '_schoolId_fkey',
        CASE WHEN t = 'gateway_event' THEN 'SET NULL' ELSE 'RESTRICT' END);
      RAISE NOTICE 'added %_schoolId_fkey', t;
    END IF;
  END LOOP;
END $$;

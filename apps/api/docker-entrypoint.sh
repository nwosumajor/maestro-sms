#!/bin/sh
# =============================================================================
# Backend startup. By the time this runs, Compose has waited for Postgres + Redis
# healthchecks (depends_on: service_healthy). Migrations, RLS grants, and seeding
# run as the PRIVILEGED migration role (DATABASE_MIGRATE_URL); the API server
# itself then runs as the least-privilege app role (DATABASE_URL) so RLS is
# enforced. Golden Rule #4.
# =============================================================================
set -e

# So `prisma db seed` can find the `tsx` binary in the pruned image.
export PATH="/app/packages/db/node_modules/.bin:/app/node_modules/.bin:$PATH"

MIGRATE_URL="${DATABASE_MIGRATE_URL:-$DATABASE_URL}"

# RUN_MODE / first-arg control the lifecycle:
#   migrate  -> bootstrap the app role, migrate + RLS + seed, then EXIT (cloud:
#              run as a one-off ECS task before flipping services).
#   server   -> start the API only; NEVER migrate (cloud: the long-lived service).
#   (unset)  -> legacy local-compose behaviour: migrate then start, in one process.
MODE="${1:-${RUN_MODE:-all}}"

if [ "$MODE" = "server" ]; then
  echo "[entrypoint] starting API as the least-privilege app role (no migrations)..."
  exec node apps/api/dist/main.js
fi

if [ "$MODE" = "retention" ]; then
  # One-shot integrity-telemetry purge (scheduled task; privileged DB via
  # DATABASE_RETENTION_URL). Exits when the sweep completes. No migrations, no
  # server, no Redis.
  echo "[entrypoint] running integrity retention sweep..."
  exec node apps/api/dist/integrity/retention/retention-cli.js
fi

# In cloud, RDS does not run infrastructure/postgres/init, so the least-privilege
# app role does not exist yet. The privileged migrate role creates it from
# APP_DB_PASSWORD. SECURITY: app role gets only CONNECT/USAGE here; table grants
# come from the RLS SQL files. Golden Rule #4 (app role != migration role).
if [ "$MODE" = "migrate" ] && [ -n "$APP_DB_PASSWORD" ]; then
  echo "[entrypoint] ensuring least-privilege app role exists..."
  APP_DB_USER="${APP_DB_USERNAME:-major_user}"
  psql "$MIGRATE_URL" -v ON_ERROR_STOP=1 \
    -v app_user="$APP_DB_USER" -v app_pw="$APP_DB_PASSWORD" <<'EOSQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_pw')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user') \gexec
EOSQL
fi

echo "[entrypoint] applying migrations (privileged role)..."
( cd packages/db && DATABASE_URL="$MIGRATE_URL" node node_modules/prisma/build/index.js migrate deploy )

# RLS apply is not idempotent (CREATE POLICY errors if it exists), so each file
# is guarded by a SENTINEL = the LAST policy it creates. If that policy exists the
# file is fully applied and is skipped; otherwise it is applied. This handles
# BOTH a fresh DB (apply all) and adding a NEW rls file to an already-initialised
# DB (apply only the new one). When you add a prisma/rls/NN_*.sql file, register
# it here with its last policy name.
echo "[entrypoint] applying RLS policies (privileged role, per-file idempotent)..."
apply_rls() {
  f="$1"; sentinel="$2"
  if psql "$MIGRATE_URL" -tAc "SELECT 1 FROM pg_policies WHERE policyname='$sentinel'" | grep -q 1; then
    echo "  -> $f (already applied)"
  else
    echo "  -> $f"
    psql "$MIGRATE_URL" -v ON_ERROR_STOP=1 -f "$f"
  fi
}
apply_rls packages/db/prisma/rls/01_integrity_rls.sql           exemption_update
apply_rls packages/db/prisma/rls/02_foundation_rls.sql          consent_update
apply_rls packages/db/prisma/rls/03_lms_rls.sql                 parent_child_select
apply_rls packages/db/prisma/rls/04_gradebook_rls.sql           grade_update
apply_rls packages/db/prisma/rls/05_workflow_rls.sql            wal_insert
apply_rls packages/db/prisma/rls/06_integrity_retention_rls.sql integrity_retention_run_select
apply_rls packages/db/prisma/rls/07_sis_rls.sql                 medical_record_update
apply_rls packages/db/prisma/rls/08_attendance_rls.sql          attendance_record_update
apply_rls packages/db/prisma/rls/09_notifications_rls.sql       notification_delivery_update
apply_rls packages/db/prisma/rls/10_fees_rls.sql                payment_update
apply_rls packages/db/prisma/rls/11_documents_rls.sql           document_delete
apply_rls packages/db/prisma/rls/12_timetable_rls.sql           timetable_entry_delete
apply_rls packages/db/prisma/rls/13_security_rls.sql            privilege_grant_update
apply_rls packages/db/prisma/rls/14_privacy_rls.sql             erasure_request_update
apply_rls packages/db/prisma/rls/15_messaging_events_rls.sql    school_event_delete
apply_rls packages/db/prisma/rls/16_hr_rls.sql                  employee_update
apply_rls packages/db/prisma/rls/17_admissions_rls.sql          admission_application_update
apply_rls packages/db/prisma/rls/18_game_rls.sql                game_result_update
apply_rls packages/db/prisma/rls/19_competition_rls.sql         standing_update
apply_rls packages/db/prisma/rls/20_game_settings_rls.sql       game_settings_update
apply_rls packages/db/prisma/rls/21_ultimate_rls.sql            ultimate_entry_link_update
apply_rls packages/db/prisma/rls/22_subscription_rls.sql        school_subscription_update
apply_rls packages/db/prisma/rls/23_lms_content_rls.sql         forum_post_update
apply_rls packages/db/prisma/rls/24_subscription_billing_rls.sql platform_subscription_payment_update
apply_rls packages/db/prisma/rls/25_hr_payroll_rls.sql          payslip_insert
apply_rls packages/db/prisma/rls/26_hr_lifecycle_rls.sql        training_record_update
apply_rls packages/db/prisma/rls/27_hr_appraisals_disciplinary_rls.sql disciplinary_entry_insert
apply_rls packages/db/prisma/rls/28_hr_recruitment_rls.sql        applicant_update
apply_rls packages/db/prisma/rls/29_school_branding_rls.sql       school_branding_update
apply_rls packages/db/prisma/rls/30_onboarding_request_rls.sql    onboarding_request_all
apply_rls packages/db/prisma/rls/31_subjects_rls.sql              class_subject_teacher_delete
apply_rls packages/db/prisma/rls/32_student_import_rls.sql        student_import_batch_update
apply_rls packages/db/prisma/rls/33_promotion_rls.sql             promotion_batch_update
apply_rls packages/db/prisma/rls/34_academic_rls.sql              term_delete
apply_rls packages/db/prisma/rls/35_announcements_rls.sql         announcement_delete
apply_rls packages/db/prisma/rls/36_hostel_rls.sql              hostel_allocation_delete
apply_rls packages/db/prisma/rls/37_transport_rls.sql            transport_assignment_delete
apply_rls packages/db/prisma/rls/38_library_rls.sql             book_loan_delete
apply_rls packages/db/prisma/rls/39_task_rls.sql                task_comment_delete
apply_rls packages/db/prisma/rls/40_poll_rls.sql                poll_vote_delete
apply_rls packages/db/prisma/rls/41_discussion_rls.sql          discussion_comment_delete
apply_rls packages/db/prisma/rls/42_discipline_rls.sql          discipline_entry_delete
apply_rls packages/db/prisma/rls/43_certificate_rls.sql         issued_certificate_insert
apply_rls packages/db/prisma/rls/44_alumni_rls.sql             alumnus_delete
apply_rls packages/db/prisma/rls/45_form_rls.sql               form_response_delete
apply_rls packages/db/prisma/rls/46_plan_pricing_rls.sql       plan_price_select
apply_rls packages/db/prisma/rls/47_subject_result_rls.sql     subject_result_update
apply_rls packages/db/prisma/rls/48_subject_selection_rls.sql  subject_selection_update
apply_rls packages/db/prisma/rls/49_parent_import_rls.sql       parent_import_batch_update
apply_rls packages/db/prisma/rls/50_scholarship_rls.sql         scholarship_application_update
apply_rls packages/db/prisma/rls/51_lms_progress_rls.sql        lms_progress_delete
apply_rls packages/db/prisma/rls/52_lms_submission_rls.sql      lms_submission_update
apply_rls packages/db/prisma/rls/53_lms_module_rls.sql          lms_module_delete
apply_rls packages/db/prisma/rls/54_lms_content_revision_rls.sql lms_content_revision_insert
apply_rls packages/db/prisma/rls/55_lms_live_rls.sql              lms_live_attendance_insert
apply_rls packages/db/prisma/rls/56_lms_award_rls.sql            lms_award_delete
apply_rls packages/db/prisma/rls/57_xapi_statement_rls.sql       xapi_statement_insert
apply_rls packages/db/prisma/rls/58_hr_compensation_rls.sql      loan_repayment_insert
apply_rls packages/db/prisma/rls/59_staff_attendance_rls.sql     attendance_kiosk_update
apply_rls packages/db/prisma/rls/60_duty_roster_rls.sql          duty_assignment_delete
apply_rls packages/db/prisma/rls/61_employment_lifecycle_rls.sql employment_change_request_update
apply_rls packages/db/prisma/rls/62_staff_exit_rls.sql           staff_exit_update
apply_rls packages/db/prisma/rls/63_biometric_rls.sql            biometric_enrollment_delete
apply_rls packages/db/prisma/rls/64_live_quiz_rls.sql            live_quiz_answer_update
apply_rls packages/db/prisma/rls/65_hangman_rls.sql              hangman_player_update
apply_rls packages/db/prisma/rls/66_live_quiz_question_delete.sql live_quiz_question_delete
apply_rls packages/db/prisma/rls/67_typing_race_rls.sql          typing_racer_update
apply_rls packages/db/prisma/rls/68_checkers_rls.sql             checkers_game_update
apply_rls packages/db/prisma/rls/69_chess_rls.sql                chess_game_update
apply_rls packages/db/prisma/rls/70_referral_rls.sql             school_referral_conversion_insert
apply_rls packages/db/prisma/rls/71_platform_fee_rls.sql         platform_fee_config_select
apply_rls packages/db/prisma/rls/72_growth_rls.sql               agent_select
apply_rls packages/db/prisma/rls/73_message_credits_rls.sql      message_credit_entry_insert
apply_rls packages/db/prisma/rls/74_group_rls.sql                school_group_marker
apply_rls packages/db/prisma/rls/75_cbt_rls.sql                  cbt_sitting_update
apply_rls packages/db/prisma/rls/76_legal_acceptance_rls.sql     legal_acceptance_insert
apply_rls packages/db/prisma/rls/77_timetable_csp_rls.sql        teacher_unavailability_delete
apply_rls packages/db/prisma/rls/78_payment_dispute_rls.sql      payment_dispute_update
apply_rls packages/db/prisma/rls/79_gateway_event_rls.sql        gateway_event_insert
apply_rls packages/db/prisma/rls/80_virtual_account_rls.sql      student_virtual_account_update
apply_rls packages/db/prisma/rls/81_installments_credit_rls.sql  student_credit_entry_insert

# Seed on first provision (compose: SEED_ON_START=true; cloud migrate task: always).
if [ "${SEED_ON_START}" = "true" ] || [ "$MODE" = "migrate" ]; then
  echo "[entrypoint] seeding (privileged role)..."
  ( cd packages/db && DATABASE_URL="$MIGRATE_URL" node node_modules/prisma/build/index.js db seed ) \
    || echo "[entrypoint] seed skipped/failed (non-fatal)"
fi

if [ "$MODE" = "migrate" ]; then
  echo "[entrypoint] migrate task complete; exiting."
  exit 0
fi

echo "[entrypoint] starting API as the least-privilege app role..."
exec node apps/api/dist/main.js

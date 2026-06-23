-- =============================================================================
-- Assessment Integrity — Row-Level Security policies + grants
-- =============================================================================
-- DELIVERED SEPARATELY FOR REVIEW (CLAUDE.md: "output RLS SQL and migrations
-- SEPARATELY for review before applying"). Run this AFTER the Prisma migration
-- that creates the integrity tables, and run it as the PRIVILEGED migration role
-- (Golden Rule #4) — never as the app role.
--
-- Tenant isolation layer 3 of 3 (JWT claim -> NestJS guard -> Postgres RLS).
-- Every policy reads the tenant from the request-scoped GUC the foundation sets:
--   SET LOCAL app.current_school_id = '<uuid from verified JWT>'
-- Policies use current_setting(..., true) so a MISSING setting yields NULL and
-- the predicate fails closed (no rows), rather than erroring open.
--
-- The application DB role is `major_user` (created by the foundation without
-- DROP/ALTER/TRUNCATE per Golden Rule #4). This migration only GRANTs the
-- least-privilege table rights it needs; it never grants schema-altering rights.
-- =============================================================================

-- A single helper so every policy fails closed identically.
-- current_setting('app.current_school_id', true) -> NULL when unset.
-- (Inlined per-policy below rather than a SQL function to keep the security
--  predicate visible at each table for review.)

-- -----------------------------------------------------------------------------
-- assessment  (read/write tenant table)
-- -----------------------------------------------------------------------------
ALTER TABLE "assessment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assessment" FORCE  ROW LEVEL SECURITY;  -- applies to table owner too

CREATE POLICY assessment_select ON "assessment"
  FOR SELECT USING (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

CREATE POLICY assessment_insert ON "assessment"
  FOR INSERT WITH CHECK (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

CREATE POLICY assessment_update ON "assessment"
  FOR UPDATE
  USING      ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

CREATE POLICY assessment_delete ON "assessment"
  FOR DELETE USING (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

-- -----------------------------------------------------------------------------
-- submission  (read/write tenant table)
-- -----------------------------------------------------------------------------
ALTER TABLE "submission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "submission" FORCE  ROW LEVEL SECURITY;

CREATE POLICY submission_select ON "submission"
  FOR SELECT USING (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

CREATE POLICY submission_insert ON "submission"
  FOR INSERT WITH CHECK (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

CREATE POLICY submission_update ON "submission"
  FOR UPDATE
  USING      ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

CREATE POLICY submission_delete ON "submission"
  FOR DELETE USING (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

-- -----------------------------------------------------------------------------
-- submission_draft  (APPEND-ONLY: only SELECT + INSERT policies exist)
-- -----------------------------------------------------------------------------
-- SECURITY: append-only enforced at the DB. With FORCE RLS and NO update/delete
-- policy, UPDATE/DELETE match zero rows -> are denied even for the app role.
-- We additionally REVOKE the table privileges so the intent is explicit and an
-- accidental future permissive policy can't silently re-open mutation.
ALTER TABLE "submission_draft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "submission_draft" FORCE  ROW LEVEL SECURITY;

CREATE POLICY submission_draft_select ON "submission_draft"
  FOR SELECT USING (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

CREATE POLICY submission_draft_insert ON "submission_draft"
  FOR INSERT WITH CHECK (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

-- -----------------------------------------------------------------------------
-- integrity_signal  (APPEND-ONLY: only SELECT + INSERT policies exist)
-- -----------------------------------------------------------------------------
-- SECURITY: mirrors AuditLog. Signals are immutable evidence for human review
-- (Golden Rule #8) — never edited or deleted by the app. Same append-only
-- enforcement as submission_draft.
ALTER TABLE "integrity_signal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integrity_signal" FORCE  ROW LEVEL SECURITY;

CREATE POLICY integrity_signal_select ON "integrity_signal"
  FOR SELECT USING (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

CREATE POLICY integrity_signal_insert ON "integrity_signal"
  FOR INSERT WITH CHECK (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

-- -----------------------------------------------------------------------------
-- submission_telemetry  (APPEND-ONLY: only SELECT + INSERT policies exist)
-- -----------------------------------------------------------------------------
-- SECURITY: raw client telemetry feeding the server detectors. Same append-only
-- + fail-closed posture as submission_draft / integrity_signal.
ALTER TABLE "submission_telemetry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "submission_telemetry" FORCE  ROW LEVEL SECURITY;

CREATE POLICY submission_telemetry_select ON "submission_telemetry"
  FOR SELECT USING (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

CREATE POLICY submission_telemetry_insert ON "submission_telemetry"
  FOR INSERT WITH CHECK (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

-- -----------------------------------------------------------------------------
-- student_integrity_exemption  (read/write, but DELETE intentionally omitted)
-- -----------------------------------------------------------------------------
-- SECURITY: accommodation records are never hard-deleted; revocation is a soft
-- delete via revokedAt (UPDATE). No DELETE policy is created.
ALTER TABLE "student_integrity_exemption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "student_integrity_exemption" FORCE  ROW LEVEL SECURITY;

CREATE POLICY exemption_select ON "student_integrity_exemption"
  FOR SELECT USING (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

CREATE POLICY exemption_insert ON "student_integrity_exemption"
  FOR INSERT WITH CHECK (
    "schoolId" = current_setting('app.current_school_id', true)::uuid
  );

CREATE POLICY exemption_update ON "student_integrity_exemption"
  FOR UPDATE
  USING      ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

-- =============================================================================
-- Least-privilege table grants for the app role (Golden Rule #4).
-- No DROP/ALTER/TRUNCATE is ever granted here; those stay with the migration
-- role. `major_user` is the foundation's application role.
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "assessment"                  TO major_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "submission"                  TO major_user;

-- Append-only: SELECT + INSERT only. Explicitly REVOKE the rest.
GRANT  SELECT, INSERT                 ON "submission_draft"            TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE       ON "submission_draft"            FROM major_user;
GRANT  SELECT, INSERT                 ON "integrity_signal"            TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE       ON "integrity_signal"            FROM major_user;
GRANT  SELECT, INSERT                 ON "submission_telemetry"        TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE       ON "submission_telemetry"        FROM major_user;

-- Exemptions: no hard delete.
GRANT  SELECT, INSERT, UPDATE         ON "student_integrity_exemption" TO major_user;
REVOKE DELETE, TRUNCATE               ON "student_integrity_exemption" FROM major_user;

-- =============================================================================
-- RETENTION (Golden Rule #5: telemetry on minors is retention-bounded).
-- Append-only tables cannot be pruned by the app role (no DELETE grant above),
-- so retention runs as a SEPARATE privileged scheduled job that prunes:
--   DELETE FROM integrity_signal      WHERE "createdAt" < now() - :retention_interval;
--   DELETE FROM submission_draft      WHERE "createdAt" < now() - :retention_interval;
--   DELETE FROM submission_telemetry  WHERE "createdAt" < now() - :retention_interval;
-- The retention window is a per-school policy value (NDPR-aligned) read from the
-- School registry (School.integrityRetentionDays), applied per tenant.
-- IMPLEMENTED: apps/api/src/integrity/retention (BullMQ daily worker + manual
-- admin endpoint); its RLS + the dedicated retention role are in
-- prisma/rls/06_integrity_retention_rls.sql.
-- =============================================================================

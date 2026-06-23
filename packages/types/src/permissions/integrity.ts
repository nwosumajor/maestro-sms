// =============================================================================
// Assessment Integrity — permission constants (single source of truth)
// =============================================================================
// Additive to the foundation permission registry. Import and spread these into
// the foundation's PERMISSIONS map and role->permission mappings rather than
// editing those in place, e.g.:
//
//   import { INTEGRITY_PERMISSIONS } from "@sms/types/permissions/integrity";
//   export const PERMISSIONS = { ...CORE_PERMISSIONS, ...INTEGRITY_PERMISSIONS };
//
// Fine-grained strings, matching the foundation convention `<entity>.<action>`.
// Enforced in NestJS via @RequirePermission(...), backstopped by RLS.
// =============================================================================

export const INTEGRITY_PERMISSIONS = {
  /** Create/edit assessments and their integrity toggles. Teacher, school_admin. */
  ASSESSMENT_WRITE: "assessment.write",
  /** Read assessment metadata. Teacher, school_admin; students read assigned. */
  ASSESSMENT_READ: "assessment.read",

  /** Create/update one's OWN submission (student). Ownership checked in guard. */
  SUBMISSION_WRITE: "submission.write",
  /** Read submissions. Teacher (own classes), school_admin; student (own only). */
  SUBMISSION_READ: "submission.read",

  /**
   * Emit a CLIENT integrity signal for one's own in-progress submission.
   * Granted to students; the API still verifies the submission belongs to the
   * caller. Clients can never write SERVER-sourced signals.
   */
  SIGNAL_CREATE: "integrity.signal.create",

  /**
   * Read the per-submission Integrity Report (aggregated signals + evidence).
   * Teacher, school_admin ONLY. Students and parents are intentionally absent —
   * raw signals are never disclosed to them (Golden Rule #5 / spec "Surfacing").
   */
  REPORT_READ: "integrity.report.read",

  /** Grant/revoke a student integrity (accessibility) exemption. */
  EXEMPTION_WRITE: "integrity.exemption.write",
  /** Read exemptions. Teacher, school_admin. */
  EXEMPTION_READ: "integrity.exemption.read",

  /**
   * Manually run the NDPR retention purge for one's own school, and view the
   * retention-run history. principal, school_admin. The cross-tenant SCHEDULED
   * sweep needs no permission (it runs as the privileged job, not a user).
   */
  RETENTION_RUN: "integrity.retention.run",
} as const;

export type IntegrityPermission =
  (typeof INTEGRITY_PERMISSIONS)[keyof typeof INTEGRITY_PERMISSIONS];

// -----------------------------------------------------------------------------
// Suggested role -> permission additions (spread into the foundation mapping).
// NOTE: students/parents are deliberately NOT granted REPORT_READ.
// -----------------------------------------------------------------------------
export const INTEGRITY_ROLE_PERMISSIONS = {
  school_admin: [
    INTEGRITY_PERMISSIONS.ASSESSMENT_WRITE,
    INTEGRITY_PERMISSIONS.ASSESSMENT_READ,
    INTEGRITY_PERMISSIONS.SUBMISSION_READ,
    INTEGRITY_PERMISSIONS.REPORT_READ,
    INTEGRITY_PERMISSIONS.EXEMPTION_WRITE,
    INTEGRITY_PERMISSIONS.EXEMPTION_READ,
    INTEGRITY_PERMISSIONS.RETENTION_RUN,
  ],
  teacher: [
    INTEGRITY_PERMISSIONS.ASSESSMENT_WRITE,
    INTEGRITY_PERMISSIONS.ASSESSMENT_READ,
    INTEGRITY_PERMISSIONS.SUBMISSION_READ,
    INTEGRITY_PERMISSIONS.REPORT_READ,
    INTEGRITY_PERMISSIONS.EXEMPTION_WRITE,
    INTEGRITY_PERMISSIONS.EXEMPTION_READ,
  ],
  student: [
    INTEGRITY_PERMISSIONS.ASSESSMENT_READ,
    INTEGRITY_PERMISSIONS.SUBMISSION_WRITE,
    INTEGRITY_PERMISSIONS.SUBMISSION_READ, // own submissions only (ownership check)
    INTEGRITY_PERMISSIONS.SIGNAL_CREATE,
  ],
  parent: [
    // Intentionally empty for integrity: parents never see raw signals.
  ],
} as const;

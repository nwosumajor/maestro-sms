// =============================================================================
// Privacy / NDPR — permission constants
// =============================================================================
// Data EXPORT and raising an erasure REQUEST need no special permission — they
// are data-subject rights, gated by relationship scoping (self / guardian /
// staff) in the service. REVIEWING an erasure request is a data-controller
// action (school_admin / principal).
// =============================================================================

export const PRIVACY_PERMISSIONS = {
  /** Review (approve/reject) right-to-erasure requests. */
  ERASURE_REVIEW: "privacy.erasure.review",
  /** Record and manage personal-data breaches, and read the compliance posture.
   *  Separate from erasure review because the people who answer a DPO are not
   *  necessarily the people who decide an individual's erasure request. */
  COMPLIANCE_MANAGE: "privacy.compliance.manage",
  /**
   * Produce and retrieve a year's institutional archive.
   *
   * ITS OWN PERMISSION, not folded into compliance.manage: an archive carries
   * the WHOLE record for a year — every pupil's file plus staff employment and
   * DECRYPTED salaries — in a single downloadable object. That is a wider blast
   * radius than anything else one permission grants, so it is held deliberately
   * rather than inherited by whoever happens to handle breach paperwork.
   */
  ARCHIVE_MANAGE: "privacy.archive.manage",
} as const;

export type PrivacyPermission =
  (typeof PRIVACY_PERMISSIONS)[keyof typeof PRIVACY_PERMISSIONS];

export const PRIVACY_ROLE_PERMISSIONS = {
  principal: [PRIVACY_PERMISSIONS.ERASURE_REVIEW, PRIVACY_PERMISSIONS.COMPLIANCE_MANAGE],
  school_admin: [PRIVACY_PERMISSIONS.ERASURE_REVIEW, PRIVACY_PERMISSIONS.COMPLIANCE_MANAGE],
} as const;

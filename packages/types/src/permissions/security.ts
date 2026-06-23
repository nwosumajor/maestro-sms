// =============================================================================
// Security — permission constants (single source of truth)
// =============================================================================
// Governs the audit viewer and Just-In-Time privilege elevation. ELEVATION is
// the controlled way to GRANT a temporary extra permission; APPROVE must be a
// different person than the requester (separation of duties), enforced in the
// service.
// =============================================================================

export const SECURITY_PERMISSIONS = {
  /** Read the (scoped) audit log. principal / school_admin / super_admin. */
  AUDIT_READ: "security.audit.read",
  /** Request a temporary elevation (any trusted staff). */
  ELEVATION_REQUEST: "security.elevation.request",
  /** Approve / revoke an elevation request. principal / school_admin. */
  ELEVATION_APPROVE: "security.elevation.approve",
} as const;

export type SecurityPermission =
  (typeof SECURITY_PERMISSIONS)[keyof typeof SECURITY_PERMISSIONS];

/** Suggested role -> permission additions (spread into the foundation mapping). */
export const SECURITY_ROLE_PERMISSIONS = {
  principal: [
    SECURITY_PERMISSIONS.AUDIT_READ,
    SECURITY_PERMISSIONS.ELEVATION_REQUEST,
    SECURITY_PERMISSIONS.ELEVATION_APPROVE,
  ],
  school_admin: [
    SECURITY_PERMISSIONS.AUDIT_READ,
    SECURITY_PERMISSIONS.ELEVATION_REQUEST,
    SECURITY_PERMISSIONS.ELEVATION_APPROVE,
  ],
  accountant: [SECURITY_PERMISSIONS.ELEVATION_REQUEST],
  hr_clerk: [SECURITY_PERMISSIONS.ELEVATION_REQUEST],
  teacher: [SECURITY_PERMISSIONS.ELEVATION_REQUEST],
} as const;

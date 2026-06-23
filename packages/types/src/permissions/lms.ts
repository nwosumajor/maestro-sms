// =============================================================================
// LMS — permission constants (single source of truth)
// =============================================================================
// Coarse permissions gate the ENDPOINTS; relationship scoping (teacher->their
// classes, student->enrolled, parent->their children) narrows the ROWS in the
// service layer, backstopped by RLS. A teacher having `class.read` does NOT mean
// they can read every class — only the ones they teach.
// =============================================================================

export const LMS_PERMISSIONS = {
  /** Read classes (rows further narrowed by relationship scoping). */
  CLASS_READ: "class.read",
  /** Create/edit classes. school_admin. */
  CLASS_WRITE: "class.write",
  /** Read class rosters / enrollments. teacher (own classes), school_admin. */
  ENROLLMENT_READ: "enrollment.read",
  /** Enroll/unenroll students, assign teachers. school_admin. */
  ENROLLMENT_WRITE: "enrollment.write",
  /** Link/unlink a guardian to a student. school_admin. */
  GUARDIAN_WRITE: "guardian.write",
} as const;

export type LmsPermission = (typeof LMS_PERMISSIONS)[keyof typeof LMS_PERMISSIONS];

/** Suggested role -> permission additions (spread into the foundation mapping). */
export const LMS_ROLE_PERMISSIONS = {
  school_admin: [
    LMS_PERMISSIONS.CLASS_READ,
    LMS_PERMISSIONS.CLASS_WRITE,
    LMS_PERMISSIONS.ENROLLMENT_READ,
    LMS_PERMISSIONS.ENROLLMENT_WRITE,
    LMS_PERMISSIONS.GUARDIAN_WRITE,
  ],
  teacher: [LMS_PERMISSIONS.CLASS_READ, LMS_PERMISSIONS.ENROLLMENT_READ],
  student: [LMS_PERMISSIONS.CLASS_READ],
  parent: [LMS_PERMISSIONS.CLASS_READ],
} as const;

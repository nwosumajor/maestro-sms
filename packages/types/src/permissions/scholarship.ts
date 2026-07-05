// =============================================================================
// Scholarship — permission constants
// =============================================================================
// Platform-owned sponsorship. `scholarship.admin` is a PLATFORM/cross-tenant
// permission (create programs, review + award across schools) held only by
// super_admin — like game.ultimate.admin it is NON-ELEVATABLE. `scholarship.apply`
// lets a parent/teacher apply for a student in THEIR school (relationship-scoped
// in the service). `scholarship.read` gives school leadership oversight of their
// own students' applications.
// =============================================================================

export const SCHOLARSHIP_PERMISSIONS = {
  /** Apply for a student + manage/consent to OWN applications. parent, teacher. */
  APPLY: "scholarship.apply",
  /** Oversight of a school's own students' applications. principal, school_admin. */
  READ: "scholarship.read",
  /** Platform owner: create/edit programs + review + award. super_admin only. */
  ADMIN: "scholarship.admin",
} as const;

export type ScholarshipPermission =
  (typeof SCHOLARSHIP_PERMISSIONS)[keyof typeof SCHOLARSHIP_PERMISSIONS];

export const SCHOLARSHIP_ROLE_PERMISSIONS = {
  principal: [SCHOLARSHIP_PERMISSIONS.READ],
  school_admin: [SCHOLARSHIP_PERMISSIONS.READ],
  board: [SCHOLARSHIP_PERMISSIONS.READ],
  teacher: [SCHOLARSHIP_PERMISSIONS.APPLY],
  parent: [SCHOLARSHIP_PERMISSIONS.APPLY],
} as const;

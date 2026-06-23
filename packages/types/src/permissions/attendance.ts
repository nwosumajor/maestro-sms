// =============================================================================
// Attendance — permission constants (single source of truth)
// =============================================================================
// Coarse permissions gate the ENDPOINTS; relationship scoping (teacher-of-class
// to write/read their class; parent/student to read their own) narrows the ROWS
// in AttendanceService, backstopped by RLS.
// =============================================================================

export const ATTENDANCE_STATUSES = ["PRESENT", "ABSENT", "LATE", "EXCUSED"] as const;
export type AttendanceStatusValue = (typeof ATTENDANCE_STATUSES)[number];

export const ATTENDANCE_PERMISSIONS = {
  /** Read attendance (rows narrowed by relationship: own class / own child / self). */
  ATTENDANCE_READ: "attendance.read",
  /** Take/correct attendance for a class. teacher (own classes), school staff. */
  ATTENDANCE_WRITE: "attendance.write",
} as const;

export type AttendancePermission =
  (typeof ATTENDANCE_PERMISSIONS)[keyof typeof ATTENDANCE_PERMISSIONS];

/** Suggested role -> permission additions (spread into the foundation mapping). */
export const ATTENDANCE_ROLE_PERMISSIONS = {
  principal: [ATTENDANCE_PERMISSIONS.ATTENDANCE_READ, ATTENDANCE_PERMISSIONS.ATTENDANCE_WRITE],
  school_admin: [ATTENDANCE_PERMISSIONS.ATTENDANCE_READ, ATTENDANCE_PERMISSIONS.ATTENDANCE_WRITE],
  teacher: [ATTENDANCE_PERMISSIONS.ATTENDANCE_READ, ATTENDANCE_PERMISSIONS.ATTENDANCE_WRITE],
  parent: [ATTENDANCE_PERMISSIONS.ATTENDANCE_READ],
  student: [ATTENDANCE_PERMISSIONS.ATTENDANCE_READ],
} as const;

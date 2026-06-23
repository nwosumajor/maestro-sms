// =============================================================================
// Timetabling — permission constants (single source of truth)
// =============================================================================
// Coarse permissions gate the ENDPOINTS; relationship scoping (teacher -> own
// lessons, student -> enrolled class, parent -> children, staff -> all) narrows
// the ROWS in TimetableService, backstopped by RLS.
// =============================================================================

export const DAYS_OF_WEEK = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;
export type DayOfWeekValue = (typeof DAYS_OF_WEEK)[number];

export const TIMETABLE_PERMISSIONS = {
  /** View the timetable (rows narrowed by relationship). */
  TIMETABLE_READ: "timetable.read",
  /** Manage periods, rooms, and lesson entries. school_admin / principal. */
  TIMETABLE_WRITE: "timetable.write",
} as const;

export type TimetablePermission =
  (typeof TIMETABLE_PERMISSIONS)[keyof typeof TIMETABLE_PERMISSIONS];

/** Suggested role -> permission additions (spread into the foundation mapping). */
export const TIMETABLE_ROLE_PERMISSIONS = {
  principal: [TIMETABLE_PERMISSIONS.TIMETABLE_READ, TIMETABLE_PERMISSIONS.TIMETABLE_WRITE],
  school_admin: [TIMETABLE_PERMISSIONS.TIMETABLE_READ, TIMETABLE_PERMISSIONS.TIMETABLE_WRITE],
  board: [TIMETABLE_PERMISSIONS.TIMETABLE_READ],
  teacher: [TIMETABLE_PERMISSIONS.TIMETABLE_READ],
  student: [TIMETABLE_PERMISSIONS.TIMETABLE_READ],
  parent: [TIMETABLE_PERMISSIONS.TIMETABLE_READ],
} as const;

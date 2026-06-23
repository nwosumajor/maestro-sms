// =============================================================================
// Gradebook — permission constants
// =============================================================================
// grade.write is teacher/school_admin; relationship scoping further restricts a
// teacher to submissions in THEIR classes. Students/parents only ever READ
// PUBLISHED grades (and only their own / their children's) — never raw drafts.
// =============================================================================

export const GRADEBOOK_PERMISSIONS = {
  /** Read grades (rows narrowed by relationship scoping + publish status). */
  GRADE_READ: "grade.read",
  /** Create/update a grade on a submission. teacher (own classes), school_admin. */
  GRADE_WRITE: "grade.write",
} as const;

export type GradebookPermission =
  (typeof GRADEBOOK_PERMISSIONS)[keyof typeof GRADEBOOK_PERMISSIONS];

export const GRADEBOOK_ROLE_PERMISSIONS = {
  school_admin: [GRADEBOOK_PERMISSIONS.GRADE_READ, GRADEBOOK_PERMISSIONS.GRADE_WRITE],
  teacher: [GRADEBOOK_PERMISSIONS.GRADE_READ, GRADEBOOK_PERMISSIONS.GRADE_WRITE],
  student: [GRADEBOOK_PERMISSIONS.GRADE_READ],
  parent: [GRADEBOOK_PERMISSIONS.GRADE_READ],
} as const;

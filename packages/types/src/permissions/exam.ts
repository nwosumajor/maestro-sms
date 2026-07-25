// Physical exam logistics (sittings, seating, invigilation) permissions.
export const EXAM_PERMISSIONS = {
  /** Manage exam sittings, seating plans and invigilator rosters. */
  EXAM_MANAGE: "exam.manage",
  /** Day-of authority to RELEASE (open) an approved exam for students to sit —
   *  a single time-sensitive action (principal / head teacher / school admin). */
  EXAM_RELEASE: "exam.release",
} as const;

export type ExamPermission = (typeof EXAM_PERMISSIONS)[keyof typeof EXAM_PERMISSIONS];

export const EXAM_ROLE_PERMISSIONS = {
  school_admin: [EXAM_PERMISSIONS.EXAM_MANAGE],
  principal: [EXAM_PERMISSIONS.EXAM_MANAGE],
} as const;

// CBT mock-exam hall (WAEC/JAMB/BECE-style computer-based testing).
export const CBT_PERMISSIONS = {
  /** Author question banks, create/publish/close exams, read all results. Staff. */
  CBT_MANAGE: "cbt.manage",
  /** Sit a published exam (window + duration enforced server-side). Students. */
  CBT_TAKE: "cbt.take",
} as const;
export type CbtPermission = (typeof CBT_PERMISSIONS)[keyof typeof CBT_PERMISSIONS];

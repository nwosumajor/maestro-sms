// CBT mock-exam hall (WAEC/JAMB/BECE-style computer-based testing).
export const CBT_PERMISSIONS = {
  /** Author question banks, create/publish/close exams, read all results. Staff. */
  CBT_MANAGE: "cbt.manage",
  /** Sit a published exam (window + duration enforced server-side). Students. */
  CBT_TAKE: "cbt.take",
  /**
   * READ-ONLY oversight of question banks and their questions, school-wide.
   * Held by the head teacher, who approves CBT publishing and therefore must be
   * able to read what is about to go to students — WITHOUT the authoring rights
   * of cbt.manage, and WITHOUT the marked answer key (see CbtQuestionDto).
   */
  CBT_REVIEW: "cbt.review",
} as const;
export type CbtPermission = (typeof CBT_PERMISSIONS)[keyof typeof CBT_PERMISSIONS];

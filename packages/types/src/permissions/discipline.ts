// Discipline Room — complaints, assignees, evidence, action tracking.
export const DISCIPLINE_PERMISSIONS = {
  /** File a complaint + view one's own filed complaints. Everyone in a school. */
  DISCIPLINE_FILE: "discipline.file",
  /** Review/assign/resolve complaints, see all, attach evidence. Staff. */
  DISCIPLINE_MANAGE: "discipline.manage",
} as const;
export type DisciplinePermission = (typeof DISCIPLINE_PERMISSIONS)[keyof typeof DISCIPLINE_PERMISSIONS];

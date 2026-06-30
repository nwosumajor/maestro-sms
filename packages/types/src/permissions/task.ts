// Task System — assign tasks to staff/students; assignees update + upload; comments.
export const TASK_PERMISSIONS = {
  /** Create + assign tasks, change task status, comment. Managers/teachers/admin. */
  TASK_ASSIGN: "task.assign",
  /** View my tasks, update my assignment, upload, comment. All staff + students. */
  TASK_PARTICIPATE: "task.participate",
} as const;
export type TaskPermission = (typeof TASK_PERMISSIONS)[keyof typeof TASK_PERMISSIONS];

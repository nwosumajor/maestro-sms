// Form Builder — surveys, feedback, performance-review templates.
export const FORM_PERMISSIONS = {
  /** Build/close forms + view responses. Staff. */
  FORM_MANAGE: "form.manage",
  /** View open forms in one's audience + submit a response. Everyone in a school. */
  FORM_RESPOND: "form.respond",
} as const;
export type FormPermission = (typeof FORM_PERMISSIONS)[keyof typeof FORM_PERMISSIONS];

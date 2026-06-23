// Admissions — public intake + staff review.
export const ADMISSION_PERMISSIONS = {
  /** Review (list / decide) admission applications. school_admin / principal. */
  ADMISSION_REVIEW: "admission.review",
} as const;
export type AdmissionPermission = (typeof ADMISSION_PERMISSIONS)[keyof typeof ADMISSION_PERMISSIONS];

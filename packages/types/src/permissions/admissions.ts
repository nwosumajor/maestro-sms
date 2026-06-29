// Admissions — public intake + staged maker-checker review.
export const ADMISSION_PERMISSIONS = {
  /** Review (list / decide / schedule) admission applications. Coarse gate held
   *  by school_admin / principal / hr_manager; the per-stage granular permission
   *  below is enforced inside the service. */
  ADMISSION_REVIEW: "admission.review",
} as const;
export type AdmissionPermission = (typeof ADMISSION_PERMISSIONS)[keyof typeof ADMISSION_PERMISSIONS];

/**
 * A stage in the admission maker-checker chain. Each stage names the GRANULAR
 * permission its approver must hold; the service ALSO enforces separation of
 * duties (a user may decide at most one stage), so every stage is signed off by a
 * DIFFERENT person. Mirrors STAFF_REQUEST_CHAIN, but the applicant is NOT a system
 * user, so the chain lives on the AdmissionApplication itself (not the generic
 * WorkflowRequest engine, whose initiator is a required user FK).
 */
export interface AdmissionStage {
  key: string;
  label: string;
  permission: string;
}

/** Parent enrolment review: School admin → HR → Principal (final). */
export const ADMISSION_REVIEW_CHAIN: AdmissionStage[] = [
  { key: "ADMIN", label: "School administrator", permission: "admission.review" },
  { key: "HR", label: "HR manager", permission: "workflow.review.hr" },
  { key: "PRINCIPAL", label: "Principal (final)", permission: "workflow.review.principal" },
];

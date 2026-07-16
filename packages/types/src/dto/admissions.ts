// Admissions (public intake + staged review) DTOs.

/** The comprehensive parent-enrolment form body (stored as JSONB `details`). */
export interface AdmissionDetails {
  /** Parent / guardian */
  parentName: string;
  parentEmail: string;
  parentPhone?: string | null;
  parentAddress?: string | null;
  relationship?: string | null;
  /** Child */
  childName: string;
  childDob?: string | null;
  childGender?: string | null;
  desiredClass?: string | null;
  priorSchool?: string | null;
  /** Free-form extras / medical / notes */
  notes?: string | null;
}

/** One recorded stage decision in the maker-checker trail. */
export interface AdmissionApprovalDto {
  stageKey: string;
  approverId: string;
  decision: "APPROVE" | "REJECT";
  at: string;
}

export interface AdmissionApplicationDto {
  id: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string | null;
  childName: string;
  childDob: Date | null;
  desiredClass: string | null;
  status: string;
  /** Comprehensive enrolment details (null for legacy thin applications). */
  details: AdmissionDetails | null;
  /** Maker-checker progress. */
  currentStage: number;
  stageCount: number;
  /** Label of the stage awaiting a decision, or null when terminal. */
  stageLabel: string | null;
  approvals: AdmissionApprovalDto[];
  /** Entrance-exam scheduling (communicated to the applicant on acceptance). */
  examDate: Date | null;
  examNote: string | null;
  reviewNote: string | null;
  /** Form-fee snapshot at submission (kobo; 0 = free application). */
  formFeeMinor: number;
  /** When the form fee settled; null = unpaid (staff see an UNPAID chip). */
  formFeePaidAt: Date | null;
  createdAt: Date;
}

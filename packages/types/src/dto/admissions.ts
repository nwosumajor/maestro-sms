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

/** The two states in which a family is still waiting for an answer. */
export const ADMISSION_UNDECIDED = ["NEW", "REVIEWING"] as const;

/**
 * A page of applications, plus the school-wide count still awaiting a decision.
 *
 * The list was the most-recent 200 with no filter, no paging and no total, on a
 * permanent table — and ordered newest-first, so the rows it dropped were the
 * OLDEST applications. An application that is still NEW or REVIEWING is one
 * nobody has answered; it ages exactly like an unanswered chargeback, and the
 * family that applied FIRST was the one most likely to be invisible. There was
 * also no status filter at all, so "what is still waiting on us" had no answer
 * short of reading every card.
 *
 * `undecidedTotal` is counted in SQL and is school-wide — deliberately NOT
 * narrowed by the current filter, because it answers "is a family waiting", not
 * "how many did I just search for".
 */
export interface AdmissionApplicationPageDto {
  items: AdmissionApplicationDto[];
  /** Matching the filter, not the page. */
  total: number;
  page: number;
  pageSize: number;
  /** NEW + REVIEWING school-wide, whatever the current filter is. */
  undecidedTotal: number;
  /**
   * How many of this school's undecided applications are waiting at a stage
   * NOBODY here can decide — school-wide, and deliberately not narrowed by the
   * filter, for the same reason `undecidedTotal` is not: a registrar who has
   * filtered to ACCEPTED must not thereby stop being told that twelve families
   * are stuck behind a vacant role.
   */
  blockedTotal: number;
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
  /**
   * TRUE when this school has NOBODY who can decide the stage it is waiting at.
   *
   * The chain is resolved to what the school could staff WHEN THE APPLICATION
   * ARRIVED and stored on the row, and two guards keep it satisfiable from
   * there: a stage nobody could staff is dropped at submit, and an approval
   * that would leave the rest of the chain impossible is refused. Neither can
   * reach the case where the approver LEAVES while the application waits.
   *
   * Measured on a 5,000-school fleet: 252 applications — 5% of everything
   * waiting at the principal stage — sat at a stage with no ACTIVE holder, and
   * the queue showed them as ordinary pending work. The registrar could neither
   * approve nor reject (403 both ways), the departed principal could not log in
   * at all, and there is no reassign and no reset. Each one is a family waiting
   * for an answer that can never come.
   *
   * Surfacing it is the fix, because the school already holds the lever: appoint
   * somebody to the role and the application moves. What was missing was any way
   * to know they needed to.
   */
  stageBlocked: boolean;
  approvals: AdmissionApprovalDto[];
  /** Entrance-exam scheduling (communicated to the applicant on acceptance). */
  examDate: Date | null;
  examNote: string | null;
  reviewNote: string | null;
  /** Form-fee snapshot at submission (kobo; 0 = free application). */
  formFeeMinor: number;
  /** When the form fee settled; null = unpaid (staff see an UNPAID chip). */
  formFeePaidAt: Date | null;
  /** The pupil this application became, once enrolled. The screen needs it to
   *  stop offering a button that would only answer "already done". */
  convertedStudentId: string | null;
  createdAt: Date;
}

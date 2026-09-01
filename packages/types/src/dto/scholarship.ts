import type { SupervisorStage } from "../grading";
// =============================================================================
// Scholarship — response DTOs (Date fields are `Date`; web consumes Serialized<…>)
// =============================================================================

export const SCHOLARSHIP_PROGRAM_STATUSES = ["DRAFT", "OPEN", "CLOSED", "ARCHIVED"] as const;
/**
 * Every award kind a stored programme can carry — INCLUDING one the platform
 * cannot pay out. Read `DISBURSABLE_AWARD_KINDS` before offering a choice.
 */
export const SCHOLARSHIP_AWARD_KINDS = ["FEES_CREDIT", "SUBSCRIPTION_CREDIT"] as const;

/**
 * The award kinds that actually MOVE MONEY.
 *
 * `SUBSCRIPTION_CREDIT` has been selectable since the module shipped and is
 * implemented by nothing: `decide` disburses under
 * `if (awardKind === "FEES_CREDIT")` and has no other branch, so an award of
 * the other kind marked the application AWARDED, told the family they had won,
 * spent the position against the best-three limit — and moved nothing, in
 * silence. That is the worst shape a money path can take: a success reported
 * for an outcome that never happened.
 *
 * Crediting a school's SUBSCRIPTION is a real feature with real semantics to
 * decide (does it extend the period, reduce the next charge, or sit as a
 * balance?), and inventing them would be worse than refusing. So the value
 * stays in the stored domain — no live programme uses it, and removing it would
 * make any that did unreadable — and is refused at both ends until somebody
 * builds it.
 */
export const DISBURSABLE_AWARD_KINDS = ["FEES_CREDIT"] as const;

/** Can an award of this kind actually reach the school? */
export function isDisbursableAwardKind(kind: string | null | undefined): boolean {
  return (DISBURSABLE_AWARD_KINDS as readonly string[]).includes(kind ?? "");
}
export const SCHOLARSHIP_SELECTION_BASES = ["MERIT", "NEED", "BOTH"] as const;
export const SCHOLARSHIP_APPLICATION_STATUSES = [
  "DRAFT",
  "PENDING_SUPERVISOR",
  "PENDING_PARENT",
  "PENDING_PRINCIPAL",
  "SUBMITTED",
  "UNDER_REVIEW",
  "SHORTLISTED",
  "QUALIFIED",
  "AWARDED",
  "REJECTED",
] as const;

/** Program category the platform owner selects. */
export const SCHOLARSHIP_CATEGORIES = [
  "GENERAL_SCIENCE",
  "ART",
  "COMMUNITY_DEVELOPMENT",
  "MATHEMATICS",
  "SPECIAL",
] as const;
export type ScholarshipCategory = (typeof SCHOLARSHIP_CATEGORIES)[number];

export const SCHOLARSHIP_CATEGORY_LABEL: Record<ScholarshipCategory, string> = {
  GENERAL_SCIENCE: "General Science scholarship",
  ART: "Art scholarship",
  COMMUNITY_DEVELOPMENT: "Community Development scholarship",
  MATHEMATICS: "Mathematics scholarship",
  SPECIAL: "Special scholarship",
};

/** How the qualification exam is sat. */
export const SCHOLARSHIP_EXAM_MODES = ["ONLINE_CBT", "GAMES", "PHYSICAL"] as const;
export type ScholarshipExamMode = (typeof SCHOLARSHIP_EXAM_MODES)[number];

export const SCHOLARSHIP_EXAM_MODE_LABEL: Record<ScholarshipExamMode, string> = {
  ONLINE_CBT: "Online CBT mock exam",
  GAMES: "Games arena",
  PHYSICAL: "Physical scheduled exam",
};

/** Number of awardees per program — the Best Three. */
export const SCHOLARSHIP_MAX_AWARDS = 3;

/** Award positions with human labels. */
export const SCHOLARSHIP_POSITIONS = [1, 2, 3] as const;
export type ScholarshipPosition = (typeof SCHOLARSHIP_POSITIONS)[number];
export const SCHOLARSHIP_POSITION_LABEL: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd" };

/** One owner-authored CBT question for a scholarship qualification exam.
 *  SECURITY: answerIndex never reaches applicants — announce materializes real
 *  CbtQuestion rows per school and the CBT module keeps answers server-only. */
export interface ScholarshipExamQuestion {
  text: string;
  options: string[];
  answerIndex: number;
}

/** The student's own detailed request form (stored in `answers`). The verified
 *  academics/attendance/discipline/tasks snapshot lives in `signals` — the form
 *  carries what only the student can tell us. */
export interface ScholarshipRequestForm {
  /** Why the student is requesting the scholarship (required). */
  reason: string;
  skills?: string;
  achievements?: string;
  extracurricular?: string;
  futureGoals?: string;
}

export type ScholarshipProgramStatus = (typeof SCHOLARSHIP_PROGRAM_STATUSES)[number];
export type ScholarshipAwardKind = (typeof SCHOLARSHIP_AWARD_KINDS)[number];
export type ScholarshipSelectionBasis = (typeof SCHOLARSHIP_SELECTION_BASES)[number];
export type ScholarshipApplicationStatus = (typeof SCHOLARSHIP_APPLICATION_STATUSES)[number];

/** A platform-sponsored scholarship program (global; sponsor = platform owner). */
export interface ScholarshipProgramDto {
  id: string;
  title: string;
  description: string | null;
  /** Integer minor units (kobo). awardMinor = 1st prize; 2nd/3rd fall back to it. */
  budgetMinor: number;
  /**
   * Already committed to awards on this programme.
   *
   * Shown beside the budget because a limit is only a control if the person
   * spending can see how much is left BEFORE they decide. The budget was
   * previously stored, displayed and never compared to anything; an award that
   * would exceed it is now refused, and this is the number that makes the
   * refusal predictable rather than a surprise.
   */
  committedMinor: number;
  awardMinor: number;
  award2Minor: number | null;
  award3Minor: number | null;
  awardKind: string;
  selectionBasis: string;
  eligibility: unknown | null;
  opensAt: Date;
  closesAt: Date;
  status: string;
  /** Category (GENERAL_SCIENCE | ART | COMMUNITY_DEVELOPMENT | MATHEMATICS | SPECIAL). */
  category: string;
  /** Qualification-exam details (set once candidates qualify). */
  examMode: string | null;
  examAt: Date | null;
  examVenue: string | null;
  examDurationMin: number;
  /** How many CBT questions the owner has authored (never the questions). */
  examQuestionCount: number;
  createdAt: Date;
}

/** Verified signals snapshotted at submission — for the reviewer's judgement
 *  ONLY (Golden Rule #8: signals, never a verdict). */
export interface ApplicationSignalsDto {
  /** Latest PUBLISHED session average across the student's subjects (merit). */
  publishedSessionAverage: number | null;
  /** Attendance rate % over the student's whole register history (merit). */
  attendanceRatePct: number | null;
  /** Total outstanding fees in minor units (need). */
  outstandingFeesMinor: number;
  /** ACTIVE class enrolments at submission (the student's class). */
  classNames?: string[];
  /**
   * Discipline complaints filed AGAINST the student (count only).
   *
   * LEGACY, and kept because a signals block is a SNAPSHOT of what a reviewer
   * was shown. Rewriting it would change the record of a decision already made.
   * New snapshots carry `disciplineUpheld` / `disciplineOpen` instead.
   */
  disciplineComplaints?: number;
  /**
   * Complaints CONCLUDED against the student — the school looked and upheld it.
   *
   * The old figure counted every complaint filed, at any status, and any pupil
   * can file one against another pupil (`discipline.file` is held by students).
   * So a classmate's accusation, and a complaint the school investigated and
   * DISMISSED, both counted against a child asking for a scholarship — for
   * good, next to their grade average, in front of the person deciding the
   * award. Golden Rule #8 says signals for human review, never a penalty; a
   * single number that cannot tell an accusation from a finding is a penalty
   * wearing a signal's clothes.
   *
   * DISMISSED is not reported at all: the school has already decided it was
   * baseless, and a reviewer cannot unsee a number.
   */
  disciplineUpheld?: number;
  /** Complaints still OPEN or IN_REVIEW — undecided, and shown as undecided. */
  disciplineOpen?: number;
  /** Completed (DONE) task assignments (count). */
  tasksCompleted?: number;
  capturedAt: Date;
}

/** One scholarship application (the applicant view + the platform review row). */
export interface ScholarshipApplicationDto {
  id: string;
  programId: string;
  programTitle: string;
  awardMinorOffered: number;
  schoolId: string;
  /** School name — only populated in the cross-tenant operator review view. */
  schoolName: string | null;
  studentId: string;
  studentName: string;
  applicantId: string;
  applicantName: string;
  applicantRole: string;
  answers: unknown | null;
  signals: ApplicationSignalsDto | null;
  status: string;
  consentById: string | null;
  consentAt: Date | null;
  /** Student-chain stage records (who decided + when + note). */
  supervisorById: string | null;
  supervisorAt: Date | null;
  /**
   * What actually happened at stage 1 — see `scholarshipSupervisorStage`.
   *
   * DERIVED, never stored, so it cannot drift from the row it describes. A
   * request whose class had no supervisor now skips to the guardian rather than
   * parking in a state nobody can leave; without this field that request would
   * be indistinguishable from one a teacher actually passed, and a chain that
   * quietly became two stages would read as three.
   */
  supervisorStage: SupervisorStage;
  supervisorNote: string | null;
  parentNote: string | null;
  principalById: string | null;
  principalAt: Date | null;
  principalNote: string | null;
  /** Where a REJECTED application died: SUPERVISOR | PARENT | PRINCIPAL | PLATFORM. */
  rejectedStage: string | null;
  /** Bound exam pointers (from the program) so a QUALIFIED candidate can be sent
   *  to the right surface: ONLINE_CBT -> /cbt, GAMES -> /games/ultimate. */
  examMode: string | null;
  examAt: Date | null;
  /** Qualification-exam result (CBT score % or arena relative standing %). */
  examScorePct: number | null;
  /** 1 | 2 | 3 when AWARDED — each position granted once per program. */
  awardPosition: number | null;
  awardMinor: number | null;
  /**
   * Did the award actually reach the pupil's bill?
   *
   * An award is granted and then DISBURSED as a fees credit against the pupil's
   * open invoice. When there is no open invoice — the commonest case, because an
   * award can be decided before the term's fees are raised — nothing posts,
   * nothing retries, and `disbursementPaymentId` stays null for ever. The
   * decision is sound (the award stands rather than being thrown away over a
   * posting problem) and the family is told correctly; what was missing is that
   * the FUNDER could not see it.
   *
   * `disbursementPaymentId` was written to the row and appeared in no DTO, no
   * endpoint and no screen — the same shape as `payment.platformFeeMinor`, which
   * this codebase already records as "the owner who sets the rate had no way to
   * see what it earned". Measured: four AWARDED applications totalling NGN
   * 800,000 with nothing posted, and every screen reading simply "AWARDED".
   *
   * Null when the application is not AWARDED. False means granted and not yet
   * credited — a state a human needs to resolve, not an error.
   */
  disbursed: boolean | null;
  /**
   * HOW it reached the family, because "credited" meant two different things.
   *
   * INVOICE — posted against an open invoice, so the balance has already moved.
   * CREDIT  — held on the pupil's credit ledger because there was no open
   *           invoice when the award was decided, which is the ORDINARY case:
   *           an award is often granted before the term's fees are raised. It
   *           comes off the next bill.
   *
   * Null when nothing was disbursed. A funder reading "credited" needs to know
   * which, because only one of them shows up on a balance today.
   */
  disbursementKind: "INVOICE" | "CREDIT" | null;
  reviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The parent/teacher portal payload: OPEN programs, the students the caller may
 *  apply for, and the caller's own applications. */
export interface ScholarshipPortalDto {
  programs: ScholarshipProgramDto[];
  students: { id: string; name: string }[];
  applications: ScholarshipApplicationDto[];
  /** Applications awaiting MY decision at my chain stage: a class supervisor's
   *  PENDING_SUPERVISOR items, a guardian's PENDING_PARENT items, a principal's
   *  PENDING_PRINCIPAL items. Empty for students. */
  pendingDecisions: ScholarshipApplicationDto[];
}

/**
 * One question on a scholarship exam paper, WITH its answer.
 *
 * A SEPARATE type on a SEPARATE admin-only route, deliberately — never a field
 * on `ScholarshipProgramDto`. That DTO is returned by two mappers: the operator
 * console's and the candidate PORTAL's, whose mapper carries a `// SECURITY:`
 * note that the question set "never leaves the platform-owned row toward
 * applicants". Adding the questions there would make the compiler ask the portal
 * for them too, and the obvious way to satisfy it hands every applicant the
 * answer key.
 *
 * The audience here is `scholarship.admin`, which is super_admin only and
 * NON-ELEVATABLE: the person who WROTE the paper, who must be able to read it
 * back to correct it.
 */
export interface ScholarshipExamQuestionDto {
  /** Position in the paper, which is also how a question is removed. */
  index: number;
  text: string;
  options: string[];
  answerIndex: number;
}

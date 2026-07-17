// =============================================================================
// Scholarship — response DTOs (Date fields are `Date`; web consumes Serialized<…>)
// =============================================================================

export const SCHOLARSHIP_PROGRAM_STATUSES = ["DRAFT", "OPEN", "CLOSED", "ARCHIVED"] as const;
export const SCHOLARSHIP_AWARD_KINDS = ["FEES_CREDIT", "SUBSCRIPTION_CREDIT"] as const;
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
  /** Discipline complaints filed AGAINST the student (count only). */
  disciplineComplaints?: number;
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

// =============================================================================
// Scholarship — response DTOs (Date fields are `Date`; web consumes Serialized<…>)
// =============================================================================

export const SCHOLARSHIP_PROGRAM_STATUSES = ["DRAFT", "OPEN", "CLOSED", "ARCHIVED"] as const;
export const SCHOLARSHIP_AWARD_KINDS = ["FEES_CREDIT", "SUBSCRIPTION_CREDIT"] as const;
export const SCHOLARSHIP_SELECTION_BASES = ["MERIT", "NEED", "BOTH"] as const;
export const SCHOLARSHIP_APPLICATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "SHORTLISTED",
  "AWARDED",
  "REJECTED",
] as const;

export type ScholarshipProgramStatus = (typeof SCHOLARSHIP_PROGRAM_STATUSES)[number];
export type ScholarshipAwardKind = (typeof SCHOLARSHIP_AWARD_KINDS)[number];
export type ScholarshipSelectionBasis = (typeof SCHOLARSHIP_SELECTION_BASES)[number];
export type ScholarshipApplicationStatus = (typeof SCHOLARSHIP_APPLICATION_STATUSES)[number];

/** A platform-sponsored scholarship program (global; sponsor = platform owner). */
export interface ScholarshipProgramDto {
  id: string;
  title: string;
  description: string | null;
  /** Integer minor units (kobo). */
  budgetMinor: number;
  awardMinor: number;
  awardKind: string;
  selectionBasis: string;
  eligibility: unknown | null;
  opensAt: Date;
  closesAt: Date;
  status: string;
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
}

// LMS / Classes + Workflow-summary response DTOs.

export interface ClassDto {
  id: string;
  name: string;
  subject: string | null;
  level: number | null;
  nextClassId: string | null;
  supervisorId: string | null;
}

/** A subject in the school's catalog. */
export interface SubjectDto {
  id: string;
  name: string;
  code: string | null;
}

/** A class's subject offering with its assigned teacher. */
export interface ClassSubjectDto {
  id: string;
  subjectId: string;
  subjectName: string;
  teacherId: string;
  teacherName: string;
  /** CSP timetable quota: lessons per week this offering receives. */
  lessonsPerWeek: number;
  /** Fixed room for this offering (null = assigned manually / none). */
  preferredRoomId: string | null;
}

/** Member-facing class info (parent/student/teacher view). No classmate roster. */
export interface ClassInfoDto {
  id: string;
  name: string;
  supervisorName: string | null;
  subjects: { subjectName: string; teacherName: string }[];
}

/** Promotion eligibility SIGNAL per student (never a verdict — Golden Rule #8). */
export interface ClassEligibilityDto {
  studentId: string;
  name: string;
  /** Average published score as a percentage, or null if ungraded. */
  averageScore: number | null;
  /** Attendance percentage, or null if no records. */
  attendancePercent: number | null;
}

/**
 * Per-student end-of-session outcome. The decision is ALWAYS a human's — the
 * eligibility figures are signals for the reviewer, never an automatic verdict
 * (Golden Rule #8). PROMOTE moves the student to the batch target (or graduates
 * them when there is none); RETAIN leaves them in the present class untouched;
 * DEMOTE moves them to an explicitly chosen lower class.
 */
export const PROMOTION_OUTCOMES = {
  PROMOTE: "PROMOTE",
  RETAIN: "RETAIN",
  DEMOTE: "DEMOTE",
} as const;
export type PromotionOutcome = (typeof PROMOTION_OUTCOMES)[keyof typeof PROMOTION_OUTCOMES];

/** One student's staged outcome within a promotion batch. */
export interface PromotionDecisionDto {
  studentId: string;
  outcome: PromotionOutcome;
  /** Required for DEMOTE — the class the student moves down into. */
  targetClassId?: string | null;
  /** Resolved on read for display; ignored on write. */
  targetClassName?: string | null;
  /** Free-text justification captured at stage time (shown to the approver). */
  note?: string | null;
}

/** A staged end-of-session promotion batch (maker-checker). */
export interface PromotionBatchDto {
  id: string;
  sourceClassId: string;
  sourceClassName: string;
  targetClassId: string | null;
  targetClassName: string | null;
  studentCount: number;
  status: string;
  initiatedById: string;
  reviewedById: string | null;
  reviewNote: string | null;
  createdAt: Date;
  /** Per-student outcomes. Empty for legacy batches (all students promoted). */
  decisions: PromotionDecisionDto[];
  /** Counts by outcome, so a reviewer sees the shape of the batch at a glance. */
  promoteCount: number;
  retainCount: number;
  demoteCount: number;
}

/** Compact workflow row used on the dashboard. */
export interface WorkflowSummaryDto {
  id: string;
  state: string;
}

/** Workflow row in the approvals inbox. */
export interface WorkflowInboxItemDto {
  id: string;
  type: string;
  title: string;
  state: string;
  initiatorId: string;
  createdAt: Date;
  /** Multi-stage progress (0/0 for a single-stage request). */
  currentStage: number;
  stageCount: number;
  /** Label of the stage currently awaiting approval (null when not staged/terminal). */
  stageLabel: string | null;
}

/** A senior staff member the initiator can route an approval stage to
 *  (a holder of workflow.review — principal / school_admin / head_teacher /
 *  head_admin / hr_manager). */
export interface WorkflowApproverOptionDto {
  id: string;
  name: string;
  /** Their role names, for display in the picker. */
  roles: string[];
}

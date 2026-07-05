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

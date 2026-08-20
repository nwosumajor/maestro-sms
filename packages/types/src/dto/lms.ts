// LMS / Classes + Workflow-summary response DTOs.

export interface ClassDto {
  id: string;
  name: string;
  level: number | null;
  nextClassId: string | null;
  supervisorId: string | null;
}

/**
 * A class with the figures somebody actually manages it by.
 *
 * The classes page used to render a name and the class's raw UUID, which told a
 * head of school nothing: not how many children are in it, not who is responsible
 * for it, not whether it is over capacity. Every count here is produced by a
 * grouped query over all classes at once — never one query per card.
 */
export interface ClassOverviewDto {
  id: string;
  name: string;
  code: string | null;
  level: number | null;
  /** The class pupils promote INTO; null = terminal. Carried so the page can drive
   *  its admin panels from this one response instead of also fetching /classes/mine. */
  nextClassId: string | null;
  /** Named form teacher — the person accountable for the class. */
  supervisorId: string | null;
  supervisorName: string | null;
  /** ACTIVE enrolments only: a promoted or withdrawn pupil is not in the room. */
  students: number;
  /** Max ACTIVE enrolments, or null when the school has not set one. */
  capacity: number | null;
  /** Assigned class teachers (not counting subject-only teachers). */
  teachers: number;
  /** Distinct subject offerings defined for the class. */
  subjects: number;
  /**
   * WHO TEACHES WHAT, on the list itself.
   *
   * The overview previously carried only counts ("3 teachers · 5 subjects"),
   * so answering "who takes SS3 Science A for Physics?" meant opening each
   * class in turn. These come from the same query that produces the count —
   * one read for the whole page, never one per class.
   */
  subjectTeachers: Array<{ subjectId: string; subjectName: string; teacherId: string; teacherName: string }>;
  /** Structured identity, so the list can be GROUPED rather than sorted by a
   *  name string that only looks ordered. */
  stage: string | null;
  stream: string | null;
  arm: string | null;
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
  /** A one-line, service-written summary of what is being approved — the facts
   *  an approver would otherwise have to go and look up. Never the raw payload. */
  summary: string | null;
  /** Whether THIS caller can decide THIS request right now.
   *
   *  The list is the whole tenant's register, by design — leadership can see
   *  what is in flight. But the UI offered Approve / Reject / Request revision
   *  on every pending row to anyone holding the GENERIC `workflow.review`,
   *  while the engine decides by the CURRENT STAGE's granular permission, by
   *  whether you are the initiator, by whether you already acted on an earlier
   *  stage, and by whether the stage is routed to somebody else. So the buttons
   *  were an invitation to a 403.
   *
   *  Computed on the server because only the server knows all four — and knows
   *  about an elevation grant, which is not derivable from the caller's roles. */
  awaitingMe: boolean;
}


/**
 * ONE DECIDED STAGE of a multi-stage approval.
 *
 * `viaElevation` is the field this whole DTO exists for. The engine has always
 * recorded it — "the trail should show that a stand-in decided it, not merely
 * who", says the comment where it is written — into a JSON column that nothing
 * read. A stage approved under a temporary grant looked exactly like one
 * approved by the person who holds that authority every day.
 */
export interface WorkflowApprovalDto {
  stageKey: string;
  stageLabel: string;
  approverId: string;
  approverName: string;
  at: Date;
  /** The approver held this stage's permission through an elevation grant, not
   *  their role. */
  viaElevation: boolean;
}

/** One entry of the immutable WorkflowAuditLog. */
export interface WorkflowTrailEntryDto {
  at: Date;
  actorName: string | null;
  oldState: string;
  newState: string;
  comments: string | null;
}

/**
 * The whole story of one approval request.
 *
 * `GET /workflows/:id` has always returned the request and its immutable trail,
 * and NO PAGE CALLED IT. So a school could see that a leave request, a salary
 * change, a fee run or an admin appointment was pending, and act on it, but
 * could never afterwards see WHO approved WHICH stage or WHEN. The maker-checker
 * record existed and was unreadable, which is most of the way to not having one.
 */
export interface WorkflowDetailDto {
  id: string;
  type: string;
  state: string;
  initiatorId: string;
  initiatorName: string;
  createdAt: Date;
  summary: string | null;
  currentStage: number;
  stageCount: number;
  /** The chain as designed: every stage, in order, decided or not. */
  stages: Array<{
    key: string;
    label: string;
    /** Named when the initiator routed this stage to one person. */
    routedToName: string | null;
    /** Filled once the stage has been decided. */
    decidedBy: WorkflowApprovalDto | null;
  }>;
  trail: WorkflowTrailEntryDto[];
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

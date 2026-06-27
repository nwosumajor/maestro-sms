// =============================================================================
// Approval Workflow Engine — permission constants + the state machine
// =============================================================================
// The engine is a deterministic state machine; every transition is written to an
// immutable WorkflowAuditLog (Postgres). Permissions gate WHO may act; the
// transition map gates WHAT may happen from each state.
// =============================================================================

export const WORKFLOW_PERMISSIONS = {
  /** Initiate a request (leave, purchase order, disciplinary, …) and resubmit it. */
  CREATE: "workflow.create",
  /** View requests (rows narrowed by scope: own, or in-tenant for reviewers). */
  READ: "workflow.read",
  /** Approve / reject / request revision on a pending request (coarse gate; for a
   *  STAGED request the service ALSO enforces the current stage's granular perm). */
  REVIEW: "workflow.review",
  /** Board ultimate veto override on a major (already-approved) workflow. */
  VETO: "workflow.veto",
  /** Stage-1 approver: head of teaching / head of administration. */
  REVIEW_HEAD: "workflow.review.head",
  /** Stage-2 approver: the HR manager. */
  REVIEW_HR: "workflow.review.hr",
  /** Stage-3 (final) approver: the principal. */
  REVIEW_PRINCIPAL: "workflow.review.principal",
} as const;

export type WorkflowPermission =
  (typeof WORKFLOW_PERMISSIONS)[keyof typeof WORKFLOW_PERMISSIONS];

// ---------------------------------------------------------------------------
// Multi-stage approval chains. A STAGED request carries an ordered list of
// stages; an APPROVE advances `currentStage` (staying PENDING_REVIEW) until the
// LAST stage, which finalizes to APPROVED. Each stage names the granular
// permission its approver must hold; the service ALSO enforces separation of
// duties (the initiator can't review, and a user may act at most once per
// request — so each stage is decided by a different person).
// ---------------------------------------------------------------------------
export interface WorkflowStage {
  /** Stable key for the stage (audited). */
  key: string;
  /** Human label shown in the UI. */
  label: string;
  /** Granular permission the stage's approver must hold. */
  permission: WorkflowPermission;
}

/** Staff leave / special-request chain: head → HR manager → principal (final). */
export const STAFF_REQUEST_CHAIN: WorkflowStage[] = [
  { key: "HEAD", label: "Head of teaching / administration", permission: WORKFLOW_PERMISSIONS.REVIEW_HEAD },
  { key: "HR", label: "HR manager", permission: WORKFLOW_PERMISSIONS.REVIEW_HR },
  { key: "PRINCIPAL", label: "Principal (final)", permission: WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL },
];

export const WORKFLOW_STATES = [
  "DRAFT",
  "PENDING_REVIEW",
  "REVISION_REQUESTED",
  "APPROVED",
  "REJECTED",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const WORKFLOW_ACTIONS = [
  "SUBMIT",
  "APPROVE",
  "REJECT",
  "REQUEST_REVISION",
  "VETO",
] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

/**
 * The deterministic transition table. `TRANSITIONS[state][action]` is the next
 * state, or undefined if that action is illegal from that state.
 *   DRAFT/REVISION_REQUESTED --SUBMIT--> PENDING_REVIEW
 *   PENDING_REVIEW --APPROVE--> APPROVED | --REJECT--> REJECTED
 *                  --REQUEST_REVISION--> REVISION_REQUESTED
 *   APPROVED --VETO--> REJECTED   (board override; terminal otherwise)
 */
export const WORKFLOW_TRANSITIONS: Record<
  WorkflowState,
  Partial<Record<WorkflowAction, WorkflowState>>
> = {
  DRAFT: { SUBMIT: "PENDING_REVIEW" },
  REVISION_REQUESTED: { SUBMIT: "PENDING_REVIEW" },
  PENDING_REVIEW: {
    APPROVE: "APPROVED",
    REJECT: "REJECTED",
    REQUEST_REVISION: "REVISION_REQUESTED",
  },
  APPROVED: { VETO: "REJECTED" },
  REJECTED: {},
};

/** Which permission an action requires. */
export const WORKFLOW_ACTION_PERMISSION: Record<WorkflowAction, WorkflowPermission> = {
  SUBMIT: WORKFLOW_PERMISSIONS.CREATE, // initiator resubmits
  APPROVE: WORKFLOW_PERMISSIONS.REVIEW,
  REJECT: WORKFLOW_PERMISSIONS.REVIEW,
  REQUEST_REVISION: WORKFLOW_PERMISSIONS.REVIEW,
  VETO: WORKFLOW_PERMISSIONS.VETO,
};

export const WORKFLOW_TYPES = [
  "LEAVE",
  "STAFF_REQUEST",
  "PURCHASE_ORDER",
  "DISCIPLINARY",
  "LMS_CONTENT_PUBLISH",
] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

/** Types that route through the multi-stage STAFF_REQUEST_CHAIN. */
export const STAGED_WORKFLOW_TYPES: ReadonlySet<WorkflowType> = new Set<WorkflowType>([
  "LEAVE",
  "STAFF_REQUEST",
]);

// ---------------------------------------------------------------------------
// Special-request categories + per-type initiation rules. A STAFF_REQUEST
// carries a structured payload { category, details, neededBy? }. Each workflow
// TYPE declares who may initiate it from the API: self-service (any staff with
// workflow.create), gated by an extra permission, or system-only (created by a
// service, never the public create endpoint).
// ---------------------------------------------------------------------------
export const SPECIAL_REQUEST_CATEGORIES = [
  "EQUIPMENT",
  "TRAVEL",
  "TRAINING",
  "ALLOWANCE",
  "DOCUMENT_LETTER",
  "TRANSFER",
  "OTHER",
] as const;
export type SpecialRequestCategory = (typeof SPECIAL_REQUEST_CATEGORIES)[number];

export interface WorkflowTypeMeta {
  label: string;
  /** Any staff member (workflow.create) may initiate it. */
  selfService: boolean;
  /** Extra permission required to initiate when not self-service. */
  initiatePermission?: string;
  /** Created only by a service (never via the public create endpoint). */
  systemOnly?: boolean;
}

export const WORKFLOW_TYPE_META: Record<WorkflowType, WorkflowTypeMeta> = {
  LEAVE: { label: "Leave", selfService: true },
  STAFF_REQUEST: { label: "Special request", selfService: true },
  PURCHASE_ORDER: { label: "Purchase order", selfService: false, initiatePermission: "fee.manage" },
  DISCIPLINARY: { label: "Disciplinary", selfService: false, initiatePermission: "rbac.manage" },
  LMS_CONTENT_PUBLISH: { label: "Content publish", selfService: false, systemOnly: true },
};

/** Pure: may a user with these permissions initiate this type via the API? */
export function canInitiateWorkflowType(type: WorkflowType, permissions: string[]): boolean {
  const meta = WORKFLOW_TYPE_META[type];
  if (!meta || meta.systemOnly) return false;
  if (!permissions.includes(WORKFLOW_PERMISSIONS.CREATE)) return false;
  if (meta.selfService) return true;
  return meta.initiatePermission ? permissions.includes(meta.initiatePermission) : false;
}

/** Role -> workflow permissions (section 2 matrix). */
export const WORKFLOW_ROLE_PERMISSIONS = {
  board: [WORKFLOW_PERMISSIONS.READ, WORKFLOW_PERMISSIONS.VETO],
  principal: [
    WORKFLOW_PERMISSIONS.CREATE,
    WORKFLOW_PERMISSIONS.READ,
    WORKFLOW_PERMISSIONS.REVIEW,
  ],
  school_admin: [
    WORKFLOW_PERMISSIONS.CREATE,
    WORKFLOW_PERMISSIONS.READ,
    WORKFLOW_PERMISSIONS.REVIEW,
  ],
  teacher: [WORKFLOW_PERMISSIONS.CREATE, WORKFLOW_PERMISSIONS.READ],
  accountant: [WORKFLOW_PERMISSIONS.CREATE, WORKFLOW_PERMISSIONS.READ],
  hr_clerk: [WORKFLOW_PERMISSIONS.CREATE, WORKFLOW_PERMISSIONS.READ],
} as const;

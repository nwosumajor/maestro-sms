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
  /** Approve / reject / request revision on a pending request. */
  REVIEW: "workflow.review",
  /** Board ultimate veto override on a major (already-approved) workflow. */
  VETO: "workflow.veto",
} as const;

export type WorkflowPermission =
  (typeof WORKFLOW_PERMISSIONS)[keyof typeof WORKFLOW_PERMISSIONS];

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

export const WORKFLOW_TYPES = ["LEAVE", "PURCHASE_ORDER", "DISCIPLINARY"] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

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

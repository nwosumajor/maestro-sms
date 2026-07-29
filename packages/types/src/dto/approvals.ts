// =============================================================================
// Unified approvals inbox — every pending decision waiting on ONE person
// =============================================================================
// Approvals are deliberately implemented per-module (each owns its own
// maker-checker invariants: who may decide, separation of duties, step-up,
// in-transaction side effects). That is correct for SAFETY but leaves a senior
// staff member hunting across Fees, HR, Payroll, Security, Admissions and
// Privacy to find what is waiting on them.
//
// This DTO is the DISCOVERY layer over those sources: one list of what is
// pending for the caller, from all of them. It never carries the decision —
// each item deep-links to the module that owns it (`href`), so no module's
// approval rules are duplicated or weakened. Workflow-engine items are the one
// exception (`inline: true`): the Approvals page already decides those natively.
// =============================================================================

export const APPROVAL_SOURCES = [
  "WORKFLOW",
  "FEE_ADJUSTMENT",
  "FEE_PAYMENT",
  "ELEVATION",
  "SALARY_CHANGE",
  "STAFF_LOAN",
  "STAFF_EXIT",
  "EMPLOYMENT_CHANGE",
  "PAYROLL_RUN",
  "ADMISSION",
  "ERASURE",
] as const;
export type ApprovalSource = (typeof APPROVAL_SOURCES)[number];

/** Human label per source — used for the group headings in the inbox. */
export const APPROVAL_SOURCE_LABELS: Record<ApprovalSource, string> = {
  WORKFLOW: "Approval request",
  FEE_ADJUSTMENT: "Fee adjustment",
  FEE_PAYMENT: "Payment / refund",
  ELEVATION: "Privilege elevation",
  SALARY_CHANGE: "Salary change",
  STAFF_LOAN: "Staff loan",
  STAFF_EXIT: "Staff exit",
  EMPLOYMENT_CHANGE: "Employment change",
  PAYROLL_RUN: "Payroll run",
  ADMISSION: "Admission application",
  ERASURE: "Data erasure",
};

export interface PendingApprovalDto {
  id: string;
  source: string;
  /** Short title, e.g. "Refund — Invoice INV-1042". */
  label: string;
  /** Secondary context, e.g. "requested by A. Bello". */
  detail: string;
  /** Money at stake in minor units, when the decision moves money. */
  amountMinor: number | null;
  /** Where the decision is actually made (module-owned page). */
  href: string;
  /** True only for workflow-engine items the Approvals page decides natively. */
  inline: boolean;
  createdAt: Date;
}

/** Per-source cap so one noisy queue can never dominate (or slow) the inbox. */
export const APPROVAL_SOURCE_CAP = 25;

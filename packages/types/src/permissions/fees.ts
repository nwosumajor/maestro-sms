// =============================================================================
// Fees / Billing — permission constants (single source of truth)
// =============================================================================
// Coarse permissions gate the ENDPOINTS; relationship scoping (parent -> their
// children's invoices, student -> own, finance staff/board -> all) narrows the
// ROWS in FeesService, backstopped by RLS. Money is integer MINOR units.
// =============================================================================

export const PAYMENT_METHODS = [
  "CASH",
  "BANK_TRANSFER",
  "CARD",
  "MOBILE_MONEY",
  "OTHER",
] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number];

export const INVOICE_STATUSES = [
  "DRAFT",
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "CANCELLED",
] as const;
export type InvoiceStatusValue = (typeof INVOICE_STATUSES)[number];

export const FEES_PERMISSIONS = {
  /** Read fee items / invoices / payments (rows narrowed by relationship). */
  FEE_READ: "fee.read",
  /** Manage the catalog, issue/cancel invoices, record payments. Finance staff. */
  FEE_MANAGE: "fee.manage",
  /** Approve/reject high-value or refund payments (the "checker"; must differ
   *  from the recorder). principal / school_admin — NOT the accountant. */
  FEE_APPROVE: "fee.approve",
  /** Trigger the cross-tenant gateway reconciliation sweep (privileged,
   *  account-wide — super_admin only, like billing.dunning.run). */
  FEE_RECONCILE_RUN: "fee.reconcile.run",
} as const;

/** Payments at/above this (minor units) need a second approver. ~₦50,000. */
export const PAYMENT_APPROVAL_THRESHOLD_MINOR = 5_000_000;

/**
 * The threshold is judged against everything posted on an invoice in this
 * window, not against one payment on its own.
 *
 * Per-payment alone is trivially evaded: two payments of NGN 30,000 post
 * immediately where one of NGN 60,000 waits for a second pair of eyes.
 * Confirmed live before this was added — same amount, same person, same
 * invoice, one route through the control and one straight past it.
 *
 * 24 hours rather than "ever": a family genuinely paying in instalments across
 * a term should not have every later payment held, and the control is about a
 * large sum moving at once.
 */
export const PAYMENT_APPROVAL_WINDOW_HOURS = 24;

/**
 * Does this payment need a second signature?
 *
 * `recentPostedMinor` is what has already POSTED on the same invoice inside the
 * window. Refunds always need one, whatever the amount.
 */
export function paymentNeedsApproval(input: {
  kind: string;
  amountMinor: number;
  recentPostedMinor: number;
}): boolean {
  if (input.kind === "REFUND") return true;
  return input.amountMinor + input.recentPostedMinor >= PAYMENT_APPROVAL_THRESHOLD_MINOR;
}

/** Chargeback-rate escalation: this many disputes opened against one school
 *  within the window escalates an OPERATOR_ALERT to the platform owner (a
 *  climbing dispute rate risks the gateway suspending the merchant account). */
export const DISPUTE_ALERT_THRESHOLD = 3;
export const DISPUTE_ALERT_WINDOW_DAYS = 30;

export type FeesPermission = (typeof FEES_PERMISSIONS)[keyof typeof FEES_PERMISSIONS];

/** Suggested role -> permission additions (spread into the foundation mapping). */
export const FEES_ROLE_PERMISSIONS = {
  accountant: [FEES_PERMISSIONS.FEE_READ, FEES_PERMISSIONS.FEE_MANAGE],
  principal: [FEES_PERMISSIONS.FEE_READ, FEES_PERMISSIONS.FEE_MANAGE],
  school_admin: [FEES_PERMISSIONS.FEE_READ, FEES_PERMISSIONS.FEE_MANAGE],
  board: [FEES_PERMISSIONS.FEE_READ],
  parent: [FEES_PERMISSIONS.FEE_READ],
  student: [FEES_PERMISSIONS.FEE_READ],
} as const;

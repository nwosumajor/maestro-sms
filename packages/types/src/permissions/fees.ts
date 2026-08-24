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

/**
 * The DEFAULT threshold, in the platform's HOME currency: ₦50,000 in kobo.
 *
 * // GOTCHA: this is a naira figure and it was applied to every school on the
 * platform, whatever `school.currency` says. 5,000,000 minor units is:
 *
 *     NGN   ₦50,000        the figure intended
 *     GBP   £50,000        the control is effectively OFF
 *     GHS   GHS 50,000     likewise
 *     XOF   5,000,000 F    a zero-decimal currency: a hundred times too lax
 *
 * A maker-checker rule that never triggers is not a weaker control, it is no
 * control — and it degrades SILENTLY, on a screen that goes on saying large
 * payments need a second signature. There is no FX rate anywhere in this
 * platform and inventing one to convert a control threshold would be worse than
 * the bug, so the school is ASKED (`school.paymentApprovalThresholdMinor`).
 */
export const PAYMENT_APPROVAL_THRESHOLD_MINOR = 5_000_000;

/**
 * The threshold that actually applies to a school.
 *
 * FAIL-SAFE DIRECTION MATTERS, and it is the opposite of the one the library
 * fine uses. This is a CONTROL: an unset control must not stop protecting, so a
 * school billing in a currency the default was never written for requires a
 * second signature on EVERY payment until somebody states the figure. That is
 * loud and fixable in one save; the alternative is a two-person rule that
 * quietly never fires. Golden Rule #7.
 *
 * A school on the platform's own currency keeps the existing default, so
 * nothing changes for anyone already live.
 */
export function effectivePaymentApprovalThresholdMinor(input: {
  configuredMinor: number | null | undefined;
  currency: string | null | undefined;
}): number {
  if (input.configuredMinor != null) return input.configuredMinor;
  const currency = (input.currency || PLATFORM_HOME_CURRENCY).toUpperCase();
  return currency === PLATFORM_HOME_CURRENCY ? PAYMENT_APPROVAL_THRESHOLD_MINOR : 0;
}

/** The currency every hard-coded money constant in this platform is written in. */
export const PLATFORM_HOME_CURRENCY = "NGN";

/**
 * The overdue library fine per day that applies to a school.
 *
 * Deliberately next to `effectivePaymentApprovalThresholdMinor`, because the
 * pair is only legible together: both resolve a naira constant for a school
 * that may bill in anything, and they fail in OPPOSITE directions.
 *
 *   a CONTROL, unset  ->  tighten (every payment needs a second signature)
 *   a CHARGE,  unset  ->  zero    (no fine at all)
 *
 * An unset control that relaxes stops protecting; an unset charge that guesses
 * bills a family £50 a day for an overdue library book. Golden Rule #7 read
 * properly is "choose the more restrictive option", and which option is more
 * restrictive depends on who the rule is pointed at.
 */
export function effectiveLibraryFinePerDayMinor(input: {
  configuredMinor: number | null | undefined;
  currency: string | null | undefined;
  homeDefaultMinor: number;
}): number {
  if (input.configuredMinor != null) return input.configuredMinor;
  const currency = (input.currency || PLATFORM_HOME_CURRENCY).toUpperCase();
  return currency === PLATFORM_HOME_CURRENCY ? input.homeDefaultMinor : 0;
}

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
  /** REQUIRED, and deliberately so: making it a parameter is what finds every
   *  caller that was relying on a naira default. Same reason `PaystackService`
   *  made `currency` required. */
  thresholdMinor: number;
}): boolean {
  if (input.kind === "REFUND") return true;
  return input.amountMinor + input.recentPostedMinor >= input.thresholdMinor;
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

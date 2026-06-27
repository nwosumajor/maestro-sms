// =============================================================================
// Platform billing — permission constants (single source of truth)
// =============================================================================
// The SECOND, orthogonal layer above RBAC (which product MODULES a school's
// subscription enables) is now SELF-SERVE: a school's principal/school_admin can
// pick a tier and pay for it via Paystack. These permissions gate that surface.
// super_admin still owns cross-tenant overrides (platform.operate) and the
// cross-tenant dunning sweep. Money is integer MINOR units, NGN.
// =============================================================================

export const BILLING_PERMISSIONS = {
  /** View the school's own subscription, price quotes, and payment history. */
  BILLING_READ: "billing.read",
  /** Initiate a plan checkout / change the billing cycle. principal / school_admin. */
  BILLING_MANAGE: "billing.manage",
  /** Run the cross-tenant dunning sweep (reminders + past-due flips). super_admin. */
  BILLING_DUNNING_RUN: "billing.dunning.run",
} as const;

export type BillingPermission = (typeof BILLING_PERMISSIONS)[keyof typeof BILLING_PERMISSIONS];

/** Suggested role -> permission additions (mirrors the seed mapping). */
export const BILLING_ROLE_PERMISSIONS = {
  principal: [BILLING_PERMISSIONS.BILLING_READ, BILLING_PERMISSIONS.BILLING_MANAGE],
  school_admin: [BILLING_PERMISSIONS.BILLING_READ, BILLING_PERMISSIONS.BILLING_MANAGE],
  accountant: [BILLING_PERMISSIONS.BILLING_READ],
  board: [BILLING_PERMISSIONS.BILLING_READ],
  super_admin: [BILLING_PERMISSIONS.BILLING_DUNNING_RUN],
} as const;

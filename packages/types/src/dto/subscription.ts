// Subscription / module-entitlement DTOs (platform billing layer).
// Managed by super_admin via the Operator Console; consumed by the web nav and
// the backend ModuleGuard. No PII — purely a school's plan + module posture.

import type { BillingCycle, ModuleKey, ModuleOverrides, Plan, SubscriptionStatus } from "../modules";

/** A school's current subscription + its RESOLVED effective module set. */
export interface SubscriptionDto {
  schoolId: string;
  /** The PURCHASED tier (never downgraded by delinquency). */
  plan: Plan;
  overrides: ModuleOverrides;
  /** The effective enabled modules (effective tier + overrides), catalog order. */
  modules: ModuleKey[];
  // --- billing posture (platform revenue layer) ----------------------------
  /** ACTIVE | PAST_DUE | CANCELED. */
  status: SubscriptionStatus;
  billingCycle: BillingCycle;
  /** When the current paid period ends; null if never paid (e.g. comp/default). */
  currentPeriodEnd: Date | null;
  /** Per-school grace override (days); null -> platform default (SUBSCRIPTION_GRACE_DAYS). */
  graceDays: number | null;
  /** Seat count last billed against. */
  seats: number | null;
  /** Amount last charged (minor units of `currency`). */
  priceMinor: number | null;
  /** Currency of the last charge (NGN via Paystack / USD via Stripe); null if never paid. */
  currency: string | null;
  /** The tier actually ENFORCED now (falls to STANDARD when past-due beyond grace). */
  effectivePlan: Plan;
}

/** Operator update: pick a tier and (optionally) per-school overrides + comp. */
export interface SubscriptionUpdateDto {
  plan: Plan;
  overrides?: ModuleOverrides;
  /** super_admin comp/grant: force a status and/or extend the paid period. */
  status?: SubscriptionStatus;
  currentPeriodEnd?: Date | null;
}

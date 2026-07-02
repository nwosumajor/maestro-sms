// =============================================================================
// Platform billing DTOs (school-facing self-serve subscription)
// =============================================================================
// School staff (principal/school_admin) read their subscription + per-tier price
// quotes and start a Paystack checkout. Money is integer MINOR units (kobo), NGN.
// No student PII — purely the school's own plan/seat/payment posture.

import type { BillingCycle, Plan } from "../modules";
import type { SubscriptionDto } from "./subscription";

/** One platform subscription payment (append-only ledger row). */
export interface PlatformPaymentDto {
  id: string;
  reference: string;
  plan: Plan;
  billingCycle: BillingCycle;
  seats: number;
  amountMinor: number;
  /** PENDING | PAID | FAILED. */
  status: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

/** A live price quote for a tier at the school's current seat count + a cycle. */
export interface BillingQuoteDto {
  plan: Plan;
  billingCycle: BillingCycle;
  seats: number;
  priceMinor: number;
}

/** The full billing overview screen payload. */
export interface BillingOverviewDto {
  subscription: SubscriptionDto;
  /** Active students billed against (per-seat basis). */
  activeStudents: number;
  /** One quote per (sellable tier × cycle), for the upgrade cards. */
  quotes: BillingQuoteDto[];
  /** Most-recent-first payment history. */
  payments: PlatformPaymentDto[];
}

/** School-initiated checkout input. */
export interface CheckoutInitDto {
  plan: Plan;
  billingCycle: BillingCycle;
}

/** Hosted-checkout handoff returned to the client. */
export interface CheckoutInitResultDto {
  authorizationUrl: string;
  reference: string;
}

/** One tier's effective per-seat monthly price (operator console + public page). */
export interface PlanPriceDto {
  plan: Plan;
  /** Effective per-seat monthly price, kobo. */
  perSeatMonthlyMinor: number;
  /** True when this is the platform default (no operator override row). */
  isDefault: boolean;
  /** How many modules the tier bundles (for the public pricing cards). */
  modulesIncluded: number;
}

/** super_admin pricing update: one entry per tier to override. */
export interface PlanPriceUpdateDto {
  prices: { plan: Plan; perSeatMonthlyMinor: number }[];
}

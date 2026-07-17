// =============================================================================
// Platform billing DTOs (school-facing self-serve subscription)
// =============================================================================
// School staff (principal/school_admin) read their subscription + per-tier price
// quotes and start a Paystack checkout. Money is integer MINOR units (kobo), NGN.
// No student PII — purely the school's own plan/seat/payment posture.

import type { BillingCycle, Currency, Plan } from "../modules";
import type { SubscriptionDto } from "./subscription";

/** One platform subscription payment (append-only ledger row). */
export interface PlatformPaymentDto {
  id: string;
  reference: string;
  plan: Plan;
  billingCycle: BillingCycle;
  seats: number;
  amountMinor: number;
  /** NGN (kobo, Paystack) or USD (cents, Stripe). */
  currency: Currency;
  /** PENDING | PAID | FAILED. */
  status: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

/** A live price quote for a tier at the school's current seat count + a cycle.
 *  One quote per (tier × cycle × ALLOWED currency) — ENTERPRISE is USD-only. */
export interface BillingQuoteDto {
  plan: Plan;
  billingCycle: BillingCycle;
  seats: number;
  priceMinor: number;
  currency: Currency;
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
  /** Saved-card auto-renew: opted in, and the stored card's display hint
   *  (null = no card saved yet — one successful card payment saves it). */
  autoRenew: boolean;
  cardLast4: string | null;
  /** Credit (unused paid time) that would be deducted from a plan change made
   *  right now; 0 when lapsed / never paid. */
  planChangeCreditMinor: number;
  /** Seat top-up owed for students enrolled since the last charge (prorated to
   *  the time left); null when nothing is due. */
  trueUp: { extraSeats: number; amountMinor: number } | null;
}

/** School-initiated checkout input. Currency picks the gateway: NGN → Paystack,
 *  USD → Stripe. Omitted → the tier's default (₦, or $ for ENTERPRISE). */
export interface CheckoutInitDto {
  plan: Plan;
  billingCycle: BillingCycle;
  currency?: Currency;
}

/** Hosted-checkout handoff returned to the client. */
export interface CheckoutInitResultDto {
  authorizationUrl: string;
  reference: string;
}

/** One successful referral this school earned (append-only ledger row). */
export interface ReferralConversionDto {
  id: string;
  referredSchoolName: string;
  /** Months of free usage EACH side received (one term = 3). */
  rewardMonths: number;
  /** This school's currentPeriodEnd after the reward. */
  newPeriodEnd: Date;
  convertedAt: Date;
}

/** The school's referral panel: its shareable code (null until generated) and
 *  every conversion earned so far. */
export interface ReferralInfoDto {
  code: string | null;
  conversions: ReferralConversionDto[];
}

/** One (tier, currency)'s effective per-seat monthly price (operator console +
 *  public page). ENTERPRISE appears ONLY as a USD row. */
export interface PlanPriceDto {
  plan: Plan;
  /** NGN or USD — the row's currency (minor unit: kobo / cents). */
  currency: Currency;
  /** Effective per-seat monthly price in the currency's minor unit. */
  perSeatMonthlyMinor: number;
  /** True when this is the platform default (no operator override row). */
  isDefault: boolean;
  /** How many modules the tier bundles (for the public pricing cards). */
  modulesIncluded: number;
}

/** super_admin pricing update: one entry per (tier, currency) to override.
 *  Omitted currency = NGN (back-compat); ENTERPRISE accepts only USD. */
export interface PlanPriceUpdateDto {
  prices: { plan: Plan; perSeatMonthlyMinor: number; currency?: Currency }[];
}

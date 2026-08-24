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
 *  One quote per (tier × cycle × ALLOWED currency); every tier sells in both. */
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
  /** Metered UNBILLED seat usage already accrued (kobo/cents). Settled by the
   *  top-up, or automatically added to the next renewal charge. */
  seatArrearsMinor: number;
  /**
   * Currencies this platform can actually CHARGE in right now, and why not.
   *
   * Not a static capability list: it reflects which channels the operator has
   * switched on AND which currencies the gateway account is really enabled for.
   * ENTERPRISE is priced in USD, and a Paystack account without USD refused it
   * with a 403 that reached the school as "Payment provider error" — after they
   * had re-authenticated and committed to buying. The page needs this to avoid
   * offering a tier that cannot be bought.
   */
  currencyAvailability: Array<{ currency: Currency; available: boolean; reason: string | null }>;
}

/** School-initiated checkout input. Currency picks the gateway via
 *  `pickCardRail`: each currency's natural rail when that rail is switched on,
 *  otherwise any enabled rail that can genuinely settle it — so USD falls back
 *  to Paystack while Stripe is off. Omitted → the tier's default (₦, or $ for
 *  ENTERPRISE). */
export interface CheckoutInitDto {
  plan: Plan;
  billingCycle: BillingCycle;
  currency?: Currency;
  /** How many cycles to buy at once (default 1). Five academic years is
   *  `periods: 5` on the YEAR cycle — one charge, one period calculation. */
  periods?: number;
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

// --- operator: cross-tenant subscription revenue --------------------------- //

/** One subscription payment, as the platform's finance desk sees it. */
export interface OperatorPaymentRowDto {
  id: string;
  schoolId: string;
  schoolName: string;
  reference: string;
  plan: Plan;
  billingCycle: BillingCycle;
  kind: string;
  seats: number;
  amountMinor: number;
  currency: Currency;
  status: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

/**
 * Money totals, ALWAYS split by currency.
 *
 * Never one summed number. `amountMinor` is a count of minor units in its OWN
 * currency, so adding kobo to cents produces a figure that is not money in any
 * currency — and the platform analytics screen was doing exactly that, summing
 * every PAID payment into a single total without even selecting the currency
 * column. It happened to read correctly only because no USD payment had landed
 * yet.
 */
export interface OperatorRevenueTotalDto {
  currency: Currency;
  /** Settled money — the only figure that is actually revenue. */
  paidMinor: number;
  paidCount: number;
  /** Started but not settled. NOT revenue; shown so the desk can chase it. */
  pendingMinor: number;
  pendingCount: number;
  /** Refused by the gateway or by our own currency guard. */
  failedCount: number;
  /** Checkouts nobody completed. Not a problem — context for conversion. */
  abandonedCount: number;
}

/** The operator payments screen: one page of rows + totals for the WHOLE filter,
 *  not just the visible page. */
export interface OperatorPaymentPageDto {
  rows: OperatorPaymentRowDto[];
  page: number;
  pageSize: number;
  total: number;
  /** Totals over every row matching the filter, split by currency. */
  totals: OperatorRevenueTotalDto[];
}

// --- message credits: the school's own ledger ------------------------------ //

/** One movement on a school's message-credit ledger. */
export interface MessageCreditEntryDto {
  id: string;
  /** +credits on purchase or refund; -1 per charged message. */
  deltaCredits: number;
  /** PURCHASE | SEND | REFUND | ADJUST. CHECKPOINT rows are bookkeeping and
   *  are never shown — they record the balance without changing it. */
  reason: string;
  channel: string | null;
  reference: string | null;
  createdAt: Date;
}

/** The school's credit history, newest first. Paged: this table grows with
 *  every message ever sent and must never be returned whole. */
export interface MessageCreditLedgerPageDto {
  balance: number;
  rows: MessageCreditEntryDto[];
  page: number;
  pageSize: number;
  /**
   * Whether another page exists — NOT a total.
   *
   * A COUNT over this table is a scan of every message the school has ever
   * sent: 70ms at 900,000 entries and growing for ever. Detecting "is there
   * more" by asking for one extra row costs the same at any size, and a
   * ledger reader wants the next page, not a grand total of their own history.
   */
  hasMore: boolean;
}


/** One module's add-on price, as the operator console and the school's add-on
 *  shop both read it. `isDefault` distinguishes a code fallback from an operator
 *  decision — without it a screen cannot tell "never priced" from "priced the
 *  same as the default". */
export interface ModuleAddonPriceDto {
  module: string;
  currency: string;
  perSeatMonthlyMinor: number;
  isDefault: boolean;
}


/** One row of the school's add-on shop. `priceNowMinor` is the PRORATED cost to
 *  switch it on today; `perSeatMonthlyMinor` is what it costs from renewal. Both
 *  are shown, because a school comparing "now" against "ongoing" is exactly the
 *  question a bursar asks. */
export interface AddonOfferDto {
  module: string;
  currency: string;
  perSeatMonthlyMinor: number;
  priceNowMinor: number;
  includedInPlan: boolean;
  alreadyPurchased: boolean;
}

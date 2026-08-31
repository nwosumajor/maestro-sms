// =============================================================================
// Module entitlements & subscription plans (platform billing layer)
// =============================================================================
// Single source of truth for WHICH product modules a school's subscription
// enables. Enforced backend-side by a ModuleGuard (a 404 when a school's plan
// doesn't include the module a route belongs to) and reflected in the web nav.
//
// super_admin owns this (Operator Console): pick a named PLAN tier, then layer
// per-school OVERRIDES (force a module on/off regardless of the tier bundle).
// Schools cannot self-upgrade — entitlement is a platform/billing decision.
//
// NOTE: a handful of capabilities are NEVER module-gated and so are absent here:
// foundation auth/RBAC/audit, security governance, privacy/NDPR rights, and
// notifications (which underpin attendance/fees alerts). Those routes simply
// carry no @RequireModule tag and are always available.
// =============================================================================

export const MODULES = {
  LMS: "lms",
  GRADEBOOK: "gradebook",
  INTEGRITY: "integrity",
  SIS: "sis",
  ATTENDANCE: "attendance",
  FEES: "fees",
  DOCUMENTS: "documents",
  TIMETABLE: "timetable",
  WORKFLOW: "workflow",
  MESSAGING: "messaging",
  CALENDAR: "calendar",
  ANALYTICS: "analytics",
  HR: "hr",
  ADMISSIONS: "admissions",
  GAMES: "games",
  // Expansion modules.
  HOSTEL: "hostel",
  TRANSPORT: "transport",
  LIBRARY: "library",
  TASK: "task",
  POLL: "poll",
  DISCUSSION: "discussion",
  DISCIPLINE: "discipline",
  CERTIFICATE: "certificate",
  ALUMNI: "alumni",
  FORM: "form",
  /// Multi-school GROUP console: paid add-on for proprietors with several
  /// campuses — never in any plan bundle (sold via per-school overrides).
  GROUP: "group",
  /// CBT mock-exam hall: WAEC/JAMB-style computer-based testing — paid add-on
  /// (per-school overrides; per-sitting metering is a future refinement).
  CBT: "cbt",
} as const;

export type ModuleKey = (typeof MODULES)[keyof typeof MODULES];

/** Operator-UI catalog: stable order, human labels for the toggle list. */
export const MODULE_CATALOG: { key: ModuleKey; label: string; description: string }[] = [
  { key: MODULES.LMS, label: "Classes & LMS", description: "Classes, enrollment, guardians, course content." },
  { key: MODULES.GRADEBOOK, label: "Gradebook", description: "Manual grading and grade history." },
  { key: MODULES.INTEGRITY, label: "Assessment Integrity", description: "Cheating-signal detection for human review." },
  { key: MODULES.SIS, label: "Student Information", description: "Student profiles, contacts, medical records." },
  { key: MODULES.ATTENDANCE, label: "Attendance", description: "Daily registers and attendance history." },
  { key: MODULES.FEES, label: "Fees & Billing", description: "Fee catalog, invoices, payments." },
  { key: MODULES.DOCUMENTS, label: "Document Vault", description: "Report cards, receipts, certificates." },
  { key: MODULES.TIMETABLE, label: "Timetabling", description: "Periods, rooms, conflict-checked lessons." },
  { key: MODULES.WORKFLOW, label: "Approvals", description: "BPMN-style approval workflow engine." },
  { key: MODULES.MESSAGING, label: "Messaging", description: "Two-way participant-scoped messaging." },
  { key: MODULES.CALENDAR, label: "Calendar", description: "School events and audiences." },
  { key: MODULES.ANALYTICS, label: "Analytics", description: "Role-scoped dashboards and reports." },
  { key: MODULES.HR, label: "HR", description: "Staff employment records and salaries." },
  { key: MODULES.ADMISSIONS, label: "Admissions", description: "Public applications and staff review." },
  { key: MODULES.GAMES, label: "Dead & Wounded Games", description: "Competitive games platform." },
  { key: MODULES.LIBRARY, label: "Library", description: "Barcode catalogue, loans, fines." },
  { key: MODULES.TASK, label: "Tasks", description: "Assign tasks to staff and students." },
  { key: MODULES.POLL, label: "Polls", description: "Anonymous opinion polls." },
  { key: MODULES.DISCUSSION, label: "Discussion Hub", description: "Topic groups, posts, moderation." },
  { key: MODULES.FORM, label: "Form Builder", description: "Surveys, feedback, review forms." },
  { key: MODULES.GROUP, label: "Group Console", description: "Cross-campus dashboard for multi-school proprietors (add-on)." },
  { key: MODULES.CBT, label: "CBT Exam Hall", description: "Timed, auto-marked computer-based mock exams with question banks (add-on)." },
  { key: MODULES.CERTIFICATE, label: "Certificates & ID", description: "ID cards and certificate generator." },
  { key: MODULES.HOSTEL, label: "Hostel", description: "Boarding houses, rooms, allocation, fees." },
  { key: MODULES.TRANSPORT, label: "Transport", description: "Vehicles, routes, stops, transport fees." },
  { key: MODULES.DISCIPLINE, label: "Discipline Room", description: "Complaints, evidence, resolution." },
  { key: MODULES.ALUMNI, label: "Alumni", description: "Former-student records and broadcasts." },
];

export const PLANS = {
  STANDARD: "STANDARD",
  PREMIUM: "PREMIUM",
  ULTIMATE: "ULTIMATE",
  ENTERPRISE: "ENTERPRISE",
} as const;

export type Plan = (typeof PLANS)[keyof typeof PLANS];

// Ordered low -> high; each tier is CUMULATIVE (includes everything below it).
//
// THE ENTRY TIER IS MONETISED BY TRANSACTIONS, NOT BY SUBSCRIPTION.
//
// FEES used to sit in PREMIUM, which meant a school on the entry tier could not
// raise an invoice — and the platform's per-transaction revenue (the convenience
// fee on the Paystack split) is earned only where fees are collected. So the
// cheapest schools, the ones there are most of, generated NO transaction revenue
// at all, and the module that would have earned it was the upsell. Billing is
// also the stickiest data in the product: a school with two years of ledger here
// does not migrate.
//
// DOCUMENTS moved down with it for a coherence reason rather than a commercial
// one. Report cards and receipts are written INTO the vault by the gradebook and
// the fees ledger, and `reportcard.controller.ts` is gated on DOCUMENTS — so a
// STANDARD school had a gradebook it could record marks in and could not print a
// report card from. A tier that includes the input and withholds the output is
// not a tier, it is a bug with a price.
const STANDARD_MODULES: ModuleKey[] = [
  MODULES.LMS, MODULES.GRADEBOOK, MODULES.ATTENDANCE, MODULES.TIMETABLE, MODULES.MESSAGING, MODULES.CALENDAR,
  MODULES.SIS, MODULES.LIBRARY, MODULES.FEES, MODULES.DOCUMENTS,
];
// OVERSIGHT, ASSESSMENT AND ENGAGEMENT — the tier a school buys when it wants to
// know how it is doing and to hold the line on quality.
//
// CBT joins INTEGRITY here. They are one job seen twice — catching cheating in
// coursework and running the exam itself — and they were three tiers apart, so a
// school could buy the detection engine and not the exam hall it most applies
// to. GAMES joins the engagement group (polls, discussion, forms) where it
// belongs; bundling a games platform with payroll made ENTERPRISE impossible to
// describe in a sentence.
const PREMIUM_ADDS: ModuleKey[] = [
  MODULES.WORKFLOW, MODULES.ANALYTICS, MODULES.INTEGRITY, MODULES.CBT,
  MODULES.TASK, MODULES.POLL, MODULES.DISCUSSION, MODULES.FORM, MODULES.GAMES,
];
// THE WHOLE PUPIL, AND THE PHYSICAL SCHOOL — the lifecycle from application to
// alumnus, plus the buildings and vehicles it happens in. CERTIFICATE joins it:
// an ID card is a step in that lifecycle, and it now sits beside the admissions
// record that starts it and the alumni record that ends it rather than among the
// engagement tools.
const ULTIMATE_ADDS: ModuleKey[] = [
  MODULES.ADMISSIONS, MODULES.CERTIFICATE, MODULES.HOSTEL, MODULES.TRANSPORT, MODULES.DISCIPLINE, MODULES.ALUMNI,
];
// RUNNING A SCHOOL AS A BUSINESS: payroll, and oversight across campuses. Two
// modules, one sentence. It used to be four that shared nothing — payroll, a
// games platform, a multi-campus console and an exam hall — which meant a
// single-campus school that wanted computer-based testing had to buy payroll and
// a group console it would never open.
const ENTERPRISE_ADDS: ModuleKey[] = [MODULES.HR, MODULES.GROUP];

/** The module bundle each named tier includes (before per-school overrides). */
export const PLAN_MODULES: Record<Plan, ModuleKey[]> = {
  // Teach, register, bill. Everything a school needs to open on Monday, priced
  // low on purpose — this tier earns through the fee-collection take-rate.
  STANDARD: STANDARD_MODULES,
  // Oversight, assessment and engagement: know how you are doing, and hold the
  // line on quality.
  PREMIUM: [...STANDARD_MODULES, ...PREMIUM_ADDS],
  // The whole pupil, and the physical school.
  ULTIMATE: [...STANDARD_MODULES, ...PREMIUM_ADDS, ...ULTIMATE_ADDS],
  // Running a school as a business: payroll, and oversight across campuses.
  ENTERPRISE: [...STANDARD_MODULES, ...PREMIUM_ADDS, ...ULTIMATE_ADDS, ...ENTERPRISE_ADDS],
};

/** The lowest tier — the floor a delinquent school falls back to. */
export const FALLBACK_PLAN: Plan = PLANS.STANDARD;

/**
 * Per-school deviations from the tier bundle (force-on / force-off).
 *
 * `enabled` CONFLATED TWO DIFFERENT THINGS and they behave differently:
 *   - a module the school BOUGHT as an add-on, billed again at every renewal;
 *   - a module the OPERATOR comped, a deliberate decision outside billing.
 * Stored identically, they answered the delinquency question the same way — so
 * a school that stopped paying lost fifteen tier modules and kept every add-on
 * it had ever bought, indefinitely. `purchased` is the subset of `enabled` that
 * was paid for, so the two can be told apart; anything in `enabled` and not in
 * `purchased` is a comp and is deliberately NOT withdrawn by dunning.
 */
export interface ModuleOverrides {
  enabled?: ModuleKey[];
  disabled?: ModuleKey[];
  /** Subset of `enabled` that the school BOUGHT. Written only by the add-on
   *  settlement path — an operator toggle never marks a module purchased. */
  purchased?: ModuleKey[];
  /**
   * Add-ons the school has cancelled: still ENABLED until the period they paid
   * for ends, and never billed again.
   *
   * A school could start a recurring charge in one click and had no way to stop
   * it — the only exit was an operator hand-editing this JSON. Cancelling does
   * not switch the module off on the spot, because the last charge covered the
   * period: it stops the renewal, and the renewal that follows drops it.
   */
  cancelling?: ModuleKey[];
}

/**
 * FAIL-CLOSED default for a school with NO subscription row: the entry tier
 * (`FALLBACK_PLAN` = core teaching), NOT the full suite. A data gap therefore
 * under-provisions (core modules only) instead of silently giving away every
 * premium add-on. Every school MUST get an explicit row — onboarding creates one
 * and the seed creates one for the demo — so this only bites truly row-less
 * tenants. NOTE: deploying this against an existing DB requires backfilling a
 * subscription row for any live school that lacks one, or those tenants drop to
 * the entry tier on next request.
 */
export const DEFAULT_PLAN: Plan = FALLBACK_PLAN;

/** Effective enabled modules = the tier bundle, plus `enabled`, minus `disabled`. */
export function resolveModules(plan: Plan, overrides?: ModuleOverrides | null): ModuleKey[] {
  const set = new Set<ModuleKey>(PLAN_MODULES[plan] ?? PLAN_MODULES[DEFAULT_PLAN]);
  for (const m of overrides?.enabled ?? []) set.add(m);
  for (const m of overrides?.disabled ?? []) set.delete(m);
  // Preserve catalog order for stable output.
  return MODULE_CATALOG.map((c) => c.key).filter((k) => set.has(k));
}

export function isModuleKey(value: string): value is ModuleKey {
  return (Object.values(MODULES) as string[]).includes(value);
}

export function isPlan(value: string): value is Plan {
  return (Object.values(PLANS) as string[]).includes(value);
}

// =============================================================================
// Platform billing — per-seat pricing, billing cycles, subscription status
// =============================================================================
// Schools self-serve a tier (per-seat × active students × cycle), paid via the
// existing Paystack path. Money is integer MINOR units (kobo), NGN — same as
// Fees. Delinquency is STATUS-DRIVEN: the purchased `plan` is NEVER overwritten;
// `effectivePlan` drops to the STANDARD floor while past-due-beyond-grace, so a payment
// instantly restores the paid tier without re-resolving overrides.

export const BILLING_CYCLES = {
  MONTH: "MONTH",
  TERM: "TERM",
  YEAR: "YEAR",
} as const;
export type BillingCycle = (typeof BILLING_CYCLES)[keyof typeof BILLING_CYCLES];

/** Months billed per cycle: a TERM is 3 months; an academic YEAR is 3 terms =
 *  9 billed months (holiday months are not billed). */
export const CYCLE_MONTHS: Record<BillingCycle, number> = {
  MONTH: 1,
  TERM: 3,
  YEAR: 9,
};

/** Commitment discount per cycle (percent off the gross): pay-per-term saves
 *  5%, pay-per-year saves 15%. ONE constant drives quotes, checkout charges,
 *  the homepage marketing line and the onboarding estimate — they can't drift. */
export const CYCLE_DISCOUNT_PERCENT: Record<BillingCycle, number> = {
  MONTH: 0,
  TERM: 5,
  YEAR: 15,
};

/** Pure: apply a cycle's commitment discount to a gross minor-unit amount.
 *  Single deterministic rounding rule (round-half-up on the discounted value)
 *  so every surface computes the identical integer. */
export function applyCycleDiscountMinor(grossMinor: number, cycle: BillingCycle): number {
  return Math.round((grossMinor * (100 - CYCLE_DISCOUNT_PERCENT[cycle])) / 100);
}

export function isBillingCycle(value: string): value is BillingCycle {
  return (Object.values(BILLING_CYCLES) as string[]).includes(value);
}

// --- Platform convenience fee on ONLINE fee collection (take-rate) ------------
// The platform's cut of each online school-fee payment, taken via the gateway's
// split (`transaction_charge`) so it never touches the school's settlement.
// Operator-configured (global `platform_fee_config` row); FAIL-SAFE default is
// ZERO — no school is charged until the operator explicitly sets a fee.

export const PLATFORM_FEE_BEARERS = {
  /** The payer pays invoice + fee; the school still nets the full invoice. */
  PARENT: "PARENT",
  /** The payer pays the invoice only; the fee comes out of the school's settlement. */
  SCHOOL: "SCHOOL",
} as const;
export type PlatformFeeBearer = (typeof PLATFORM_FEE_BEARERS)[keyof typeof PLATFORM_FEE_BEARERS];
export function isPlatformFeeBearer(value: string): value is PlatformFeeBearer {
  return (Object.values(PLATFORM_FEE_BEARERS) as string[]).includes(value);
}

export interface PlatformFeeConfig {
  /** Flat component, minor units (kobo). */
  flatMinor: number;
  /** Percentage component in BASIS POINTS (100 bp = 1%). */
  percentBp: number;
  /** Ceiling on the total fee, minor units; null = uncapped. */
  capMinor: number | null;
  /** Platform-wide default bearer; a school may override its own. */
  bearer: PlatformFeeBearer;
}

export const DEFAULT_PLATFORM_FEE: PlatformFeeConfig = {
  flatMinor: 0,
  percentBp: 0,
  capMinor: null,
  bearer: PLATFORM_FEE_BEARERS.PARENT,
};

/** Pure: the platform's take on one online payment of `amountMinor`. Integer
 *  math, round-half-up on the bp component, capped, never negative, and never
 *  larger than the amount itself (a fee exceeding the payment is nonsense). */
export function computePlatformFeeMinor(amountMinor: number, cfg: PlatformFeeConfig): number {
  if (amountMinor <= 0) return 0;
  const raw = Math.max(0, cfg.flatMinor) + Math.round((amountMinor * Math.max(0, cfg.percentBp)) / 10000);
  const capped = cfg.capMinor != null ? Math.min(raw, Math.max(0, cfg.capMinor)) : raw;
  return Math.max(0, Math.min(capped, amountMinor));
}

export const SUBSCRIPTION_STATUS = {
  ACTIVE: "ACTIVE",
  PAST_DUE: "PAST_DUE",
  CANCELED: "CANCELED",
} as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[keyof typeof SUBSCRIPTION_STATUS];

export function isSubscriptionStatus(value: string): value is SubscriptionStatus {
  return (Object.values(SUBSCRIPTION_STATUS) as string[]).includes(value);
}

// --- Currency (dual-gateway billing: NGN via Paystack, USD via Stripe) -------
// Currencies and their minor-unit scale now live in `currency.ts` — the platform
// bills in more than two, and the CFA franc has no subdivision at all, which the
// old `/ 100` everywhere got wrong by a factor of a hundred.
export { CURRENCIES, isCurrency, type Currency } from "./currency";
import { CURRENCIES, isCurrency, type Currency } from "./currency";
/** Symbols for the currencies the platform bills in. Kept for the few places that
 *  want a bare glyph; anywhere formatting a real AMOUNT should use `formatMoney`,
 *  which gets the symbol AND the right number of decimals from the currency. */
export const CURRENCY_SYMBOL: Record<Currency, string> = {
  NGN: "₦",
  USD: "$",
  GHS: "₵",
  KES: "KSh",
  ZAR: "R",
  GBP: "£",
  EUR: "€",
};

/**
 * Which currencies a tier may be quoted/sold in.
 *
 * EVERY tier is sellable in BOTH, ENTERPRISE included. It used to be USD-only
 * on the reasoning that it targets international schools — but the platform's
 * only live card rail is a Paystack account not enabled for USD, so USD-only
 * meant ENTERPRISE could not be bought AT ALL. A Nigerian group on the top tier
 * had no way to pay for it, which is a revenue gap created entirely by a
 * display preference.
 *
 * The NGN price already existed (`PLAN_PRICING.ENTERPRISE`); only this gate
 * withheld it. Whether a currency can actually be CHARGED today is a separate,
 * live question answered by the payment switchboard + the gateway account's own
 * settlement currencies — not by hard-coding a market here.
 */
export function planCurrencies(plan: Plan): Currency[] {
  // Only what the platform ships PRICES for. The type permits more so a new
  // market is a price list rather than a code change; offering a currency with
  // no price would produce a checkout that cannot complete.
  void plan;
  // GHS joined NGN and USD once a price list existed for it. A Ghanaian school
  // whose fees are in cedis was being offered naira or dollars and paying FX on
  // every renewal; Paystack settles GHS, so the rail was never the obstacle.
  //
  // DERIVED FROM THE PRICE LISTS, never listed again beside them. This function's
  // own comment says "only what the platform ships PRICES for" and then repeated
  // the answer as a literal — so a fourth price list would have been added and
  // sold to nobody, silently, which is exactly how the naira/dollar pair
  // outlived the third market.
  return Object.keys(PLAN_PRICING_BY_CURRENCY).filter(isCurrency);
}
/**
 * A school's monthly run-rate, IN THE MONEY IT IS BILLED IN.
 *
 * Two services computed this independently and both did it the same wrong way:
 * `PLAN_PRICING[plan].perSeatMonthlyMinor * seats`, where `PLAN_PRICING` is the
 * NAIRA fallback table. So every school's MRR was a naira figure whatever it
 * pays in, the operator's attention queue printed it behind a hard-coded naira
 * sign, and the analytics roll-up SUMMED them — the "kobo added to cents, which
 * is not money in any currency" defect that the payments block in that very
 * file was fixed for, thirty lines below.
 *
 * It also read the CODE DEFAULTS rather than the operator's own `plan_price`
 * rows, so a price the platform owner had set was not the price their revenue
 * figures used.
 *
 * ONE function, because two spellings of one rule is how these two diverged in
 * the first place. `pricing` is `PlanPricingService.effectiveAll()`.
 *
 * A currency with no price list yields ZERO rather than a naira figure: a school
 * billed in money the platform does not price is an anomaly an operator should
 * see, not one to paper over with somebody else's number.
 */
export function monthlyRunRateMinor(
  pricing: MultiCurrencyPlanPricing,
  plan: Plan,
  currency: string,
  seats: number,
): number {
  if (!isCurrency(currency)) return 0;
  const perSeat = pricing[currency]?.[plan]?.perSeatMonthlyMinor ?? 0;
  return perSeat * Math.max(0, seats);
}

/**
 * The currency a tier is DISPLAYED in by default.
 *
 * ENTERPRISE still PRESENTS in dollars — that is its market, and the marketing
 * surfaces read this. It is a display preference only: the checkout offers both
 * and defaults to whichever can actually be charged right now, so a dollar
 * headline never blocks a naira sale.
 */
export function defaultCurrencyFor(plan: Plan): Currency {
  return plan === PLANS.ENTERPRISE ? CURRENCIES.USD : CURRENCIES.NGN;
}

/** Per-seat monthly pricing by tier, in ONE currency's minor unit (kobo/cents). */
export type PlanPricing = Record<Plan, { perSeatMonthlyMinor: number }>;
/**
 * Per-currency pricing tables.
 *
 * PARTIAL deliberately: a currency the platform can *express* is not automatically
 * a currency it can *charge in* — that needs a price list and a settlement rail.
 * Adding one is: a default price here (or an operator row in `plan_price`), and it
 * appears in checkout. Until then it is absent, and `planCurrencies` will not offer
 * it, rather than offering a tier with no price.
 */
export type MultiCurrencyPlanPricing = Partial<Record<Currency, PlanPricing>>;

/**
 * DEFAULT per-seat (per active student) price each MONTH, in kobo, by tier.
 * STANDARD is the entry tier (and the delinquency floor); higher tiers cost more
 * per seat. These are the FALLBACK values — the super_admin can override any
 * (tier, currency) price via the operator console (stored in the global
 * `plan_price` table); `PlanPricingService.effective()` merges those rows over
 * these constants, and everything that quotes or charges (billing overview,
 * checkout, the public landing page) reads the merged result.
 */
export const PLAN_PRICING: PlanPricing = {
  // ALIGNED WITH WHAT IS ACTUALLY CHARGED. These are the FALLBACK used when no
  // operator `plan_price` row exists for a currency — and they had drifted far
  // below the live NGN prices (₦200/350/500/750 against ₦525/750/975/1,250), so
  // opening a NEW currency would have quoted roughly half the real price until
  // somebody noticed. A default nobody reconciles is a default that undercharges.
  STANDARD: { perSeatMonthlyMinor: 52_500 }, // ₦525 / student / month
  PREMIUM: { perSeatMonthlyMinor: 75_000 }, // ₦750 / student / month
  ULTIMATE: { perSeatMonthlyMinor: 97_500 }, // ₦975 / student / month
  ENTERPRISE: { perSeatMonthlyMinor: 125_000 }, // ₦1,250 / student / month
};

/**
 * GHANAIAN CEDI defaults, in pesewas.
 *
 * Added because a Ghanaian school could not be BILLED in its own currency: the
 * platform shipped prices for NGN and USD only, so a school whose fees are in
 * GHS was offered naira or dollars at checkout and paid FX on every renewal for
 * no reason. Paystack settles GHS, so the rail was never the obstacle — the
 * price list was.
 *
 * The RATIOS mirror NGN exactly (1 : 1.43 : 1.86 : 2.43), because that is the
 * closest analogue market and the ladder between tiers is a product decision
 * that should not change per currency. Only the base moves.
 *
 * // These are the FALLBACK, like every list here: an operator `plan_price` row
 * for GHS overrides them, and `PlanPricingService.effective()` merges the two.
 */
export const PLAN_PRICING_GHS: PlanPricing = {
  STANDARD: { perSeatMonthlyMinor: 350 }, // GHS 3.50 / student / month
  PREMIUM: { perSeatMonthlyMinor: 500 }, // GHS 5.00
  ULTIMATE: { perSeatMonthlyMinor: 650 }, // GHS 6.50
  ENTERPRISE: { perSeatMonthlyMinor: 850 }, // GHS 8.50
};

/** USD defaults, in cents. */
export const PLAN_PRICING_USD: PlanPricing = {
  STANDARD: { perSeatMonthlyMinor: 25 }, // $0.25 / student / month
  PREMIUM: { perSeatMonthlyMinor: 40 }, // $0.40 / student / month
  ULTIMATE: { perSeatMonthlyMinor: 60 }, // $0.60 / student / month
  ENTERPRISE: { perSeatMonthlyMinor: 100 }, // $1.00 / student / month
};

/** The currencies the platform ships prices for. Typed so NGN and USD are
 *  GUARANTEED present — code may rely on those two without a null check, while a
 *  new market is still just another key. */
export const PLAN_PRICING_BY_CURRENCY: MultiCurrencyPlanPricing & {
  NGN: PlanPricing;
  USD: PlanPricing;
} = {
  NGN: PLAN_PRICING,
  USD: PLAN_PRICING_USD,
  GHS: PLAN_PRICING_GHS,
};

/** Days a school keeps its paid plan after period end before the dunning downgrade. */
export const SUBSCRIPTION_GRACE_DAYS = 7;

/** Upper bound for a PER-SCHOOL grace override. The cap is what makes grace a
 *  delegable customer-service lever (manager_admin) rather than a revenue power:
 *  bounded goodwill tops out at two months of leeway — an unbounded value would
 *  be a free comp, which stays owner-only (platform.subscription.manage). */
export const GRACE_DAYS_MAX = 60;
/** Days before period end to send a renewal reminder (2 weeks). */
export const RENEWAL_REMINDER_DAYS = 14;
/**
 * Free-trial length for a newly provisioned school before its first renewal is
 * due. Onboarding stamps currentPeriodEnd = now + this, so the dunning sweep
 * eventually flips an unpaid school to PAST_DUE (then `effectivePlan` → the
 * floor after grace) — giving the billing funnel an actual forcing function
 * instead of running the full plan free forever.
 */
export const SUBSCRIPTION_TRIAL_DAYS = 30;

/**
 * Version of the platform legal pack (docs/LEGAL.md → /legal/* pages). Bump on
 * a MATERIAL change: acceptance rows and checkout audit entries record the
 * version in force, and the AppShell banner asks billing admins to re-accept
 * when their school's latest acceptance predates this. The audit trail proves
 * which version governed which payment — never retro-apply an unaccepted one.
 */
export const LEGAL_DOCS_VERSION = "1.0";

/**
 * Referral program: months of FREE platform usage granted to EACH side when a
 * referred school's first paid subscription lands — one school term, using the
 * platform's own definition of a term (CYCLE_MONTHS.TERM = 3 months). The
 * referrer's reward extends their existing plan; the new school's stacks on top
 * of the period they just bought.
 */
export const REFERRAL_REWARD_MONTHS = CYCLE_MONTHS.TERM;

/**
 * Pure: is a school's subscription in good standing RIGHT NOW (full access)?
 * True while ACTIVE, or PAST_DUE within the grace window. False once past-due
 * beyond grace, or CANCELED past period end. Drives premium perks that lapse on
 * expiry — e.g. the custom login-page logo is hidden when this is false.
 */
export function isSubscriptionInGoodStanding(
  status: SubscriptionStatus,
  currentPeriodEnd: Date | null,
  graceDays: number = SUBSCRIPTION_GRACE_DAYS,
  now: Date = new Date(),
): boolean {
  if (status === SUBSCRIPTION_STATUS.ACTIVE) return true;
  if (!currentPeriodEnd) return false;
  const grace = status === SUBSCRIPTION_STATUS.PAST_DUE ? graceDays : 0;
  const cutoff = new Date(currentPeriodEnd.getTime() + grace * 24 * 60 * 60 * 1000);
  return now <= cutoff;
}

/** Pure: the UNDISCOUNTED price to run `plan` for `activeStudents` over one
 *  `cycle` (minor units) — per-seat monthly rate × seats × cycle months. */
export function computeSubscriptionGrossMinor(
  plan: Plan,
  activeStudents: number,
  cycle: BillingCycle,
  pricing: PlanPricing = PLAN_PRICING,
  /** Per-school overrides. Modules enabled ON TOP of the tier are billed as
   *  add-ons at their own per-seat rate; omitted, this behaves exactly as
   *  before, which is what every existing caller expects. */
  overrides?: ModuleOverrides,
): number {
  const seats = Math.max(1, Math.floor(activeStudents));
  const perSeat = pricing[plan].perSeatMonthlyMinor + addonPerSeatMonthlyMinor(plan, overrides);
  return perSeat * seats * CYCLE_MONTHS[cycle];
}

/**
 * ADD-ON PRICING — buying ONE module without changing tier.
 *
 * `ModuleOverrides.enabled` could already force any module on for any school,
 * and nothing charged for it: a per-school override was a free comp, not a
 * product. So a school that wanted only the exam hall faced the whole jump from
 * one tier to the next, for modules it would never open — and the operator's
 * only alternative was to give it away.
 *
 * PRICED PER SEAT, like the tiers, so the same lever scales with the same thing
 * and one school's bill is explainable in one sentence.
 *
 * // THE RULE THAT KEEPS THE FUNNEL HONEST: an add-on always costs MORE per
 * module than the tier that contains it. If three add-ons were cheaper than the
 * upgrade, every school would assemble its own tier and the ladder would stop
 * meaning anything. Priced this way, ONE add-on is the cheapest route to one
 * module, TWO is close, and by THREE the upgrade is plainly better — which is
 * the behaviour worth encouraging, because a school on a higher tier churns
 * less than one holding four unrelated add-ons.
 *
 * `assertAddonPricingBeatsUpgrade` in the test suite proves that for every
 * module rather than trusting the numbers to stay right by hand.
 */
export const MODULE_ADDON_PRICING: Partial<Record<ModuleKey, number>> = {
  // PREMIUM-tier modules. That tier adds five sellable modules for ₦225/seat
  // (₦45 each), so an add-on at ₦80 makes the third one worse than upgrading.
  [MODULES.WORKFLOW]: 8_000,
  [MODULES.ANALYTICS]: 8_000,
  [MODULES.INTEGRITY]: 8_000,
  [MODULES.GAMES]: 8_000,
  [MODULES.CBT]: 12_500,
  // ULTIMATE-tier modules: the tier adds six for ₦225/seat (₦37.50 each).
  // Hostel and transport are the two schools most often want on their own.
  [MODULES.ADMISSIONS]: 12_500,
  [MODULES.CERTIFICATE]: 10_000,
  [MODULES.HOSTEL]: 12_500,
  [MODULES.TRANSPORT]: 12_500,
  [MODULES.DISCIPLINE]: 10_000,
  [MODULES.ALUMNI]: 10_000,
  // ENTERPRISE-tier modules: the tier adds two for ₦275/seat (₦137.50 each).
  // Payroll alone replaces a separate system and is priced as such.
  [MODULES.HR]: 20_000,
  [MODULES.GROUP]: 20_000,
};

/**
 * USD defaults, in cents — the same ladder, priced for the USD tier table.
 *
 * // GOTCHA, and it is the third instance of a class this repo already records
 * under "A NAIRA CONSTANT IS NOT A RULE FOR EVERY SCHOOL": tier prices have been
 * per-currency since dual-currency billing shipped, and the ADD-ON table beside
 * them was a bare number applied to whatever the school is billed in. Every
 * comment above it is denominated in naira. `module_addon_price` is keyed
 * `(module, currency)` and has no rows, so EVERY currency fell through to the
 * kobo figures: a USD school was quoted HOSTEL at 12,500 cents — **$125 per seat
 * per month against a $0.65 ULTIMATE tier**, roughly 192x the tier that contains
 * it. Measured live on a provisioned school.
 *
 * `PlanPricingService.effective()` already refuses a currency it has no prices
 * for, and its comment says why: "quoting a tier at zero, OR SILENTLY AT THE
 * NAIRA PRICE, is worse than saying the market is not open yet." The add-on
 * service one file over did exactly that. Sibling asymmetry, with the correct
 * one written first and its reasoning recorded beside it.
 *
 * These figures preserve BOTH ladder invariants against `PLAN_PRICING_USD`, and
 * `add-ons-never-undercut-the-upgrade` now proves them for every shipped
 * currency rather than for naira alone — which is how the USD hole survived.
 * They are a structural default, the same standing `PLAN_PRICING_USD` has: an
 * operator `module_addon_price` row overrides them per currency.
 */
export const MODULE_ADDON_PRICING_USD: Partial<Record<ModuleKey, number>> = {
  // PREMIUM adds five sellable modules for 15c/seat (3c each).
  [MODULES.WORKFLOW]: 6,
  [MODULES.ANALYTICS]: 6,
  [MODULES.INTEGRITY]: 6,
  [MODULES.GAMES]: 6,
  [MODULES.CBT]: 9,
  // ULTIMATE adds six for 20c/seat (3.33c each).
  [MODULES.ADMISSIONS]: 9,
  [MODULES.CERTIFICATE]: 7,
  [MODULES.HOSTEL]: 9,
  [MODULES.TRANSPORT]: 9,
  [MODULES.DISCIPLINE]: 7,
  [MODULES.ALUMNI]: 7,
  // ENTERPRISE adds two for 40c/seat (20c each).
  [MODULES.HR]: 30,
  [MODULES.GROUP]: 30,
};

/**
 * Add-on prices in PESEWAS, on the same ladder the other currencies keep.
 *
 * A currency with tier prices and NO add-on prices is worse than one with
 * neither: `AddonPricingService.effective()` REFUSES an unpriced currency, so a
 * GHS school would have been able to subscribe and unable to buy a single
 * add-on. The two lists move together.
 *
 * Every figure is checked by `add-ons-never-undercut-the-upgrade`, which runs
 * for EVERY shipped currency — an add-on must cost more per module than the
 * tier containing it, three of them must cost more than the upgrade, and none
 * may exceed the whole tier.
 */
export const MODULE_ADDON_PRICING_GHS: Partial<Record<ModuleKey, number>> = {
  // PREMIUM adds five sellable modules for GHS 1.50/seat (30p each).
  [MODULES.WORKFLOW]: 55,
  [MODULES.ANALYTICS]: 55,
  [MODULES.INTEGRITY]: 55,
  [MODULES.GAMES]: 55,
  [MODULES.CBT]: 85,
  // ULTIMATE adds six for GHS 1.50/seat (25p each).
  [MODULES.ADMISSIONS]: 85,
  [MODULES.CERTIFICATE]: 70,
  [MODULES.HOSTEL]: 85,
  [MODULES.TRANSPORT]: 85,
  [MODULES.DISCIPLINE]: 70,
  [MODULES.ALUMNI]: 70,
  // ENTERPRISE adds two for GHS 2.00/seat (100p each).
  [MODULES.HR]: 150,
  [MODULES.GROUP]: 150,
};

/** Add-on prices per currency, mirroring {@link PLAN_PRICING_BY_CURRENCY}. NGN
 *  and USD are guaranteed present; a new market is another key AND a row. */
export const MODULE_ADDON_PRICING_BY_CURRENCY: Record<string, Partial<Record<ModuleKey, number>>> & {
  NGN: Partial<Record<ModuleKey, number>>;
  USD: Partial<Record<ModuleKey, number>>;
} = {
  NGN: MODULE_ADDON_PRICING,
  USD: MODULE_ADDON_PRICING_USD,
  GHS: MODULE_ADDON_PRICING_GHS,
};

/**
 * Deliberately NOT sold on their own — and this is a funnel decision, not an
 * oversight.
 *
 * Tasks, polls, discussion and forms are small engagement tools. Nobody buys a
 * polls module; pricing them individually low enough to be credible made three
 * of them cheaper than the PREMIUM upgrade, which is exactly the assemble-your-
 * own-tier behaviour add-ons must not create. Pricing them high enough to
 * protect the ladder would have been a price no school would pay.
 *
 * So they stay tier sweeteners: the reason to move to PREMIUM rather than
 * things to buy beside it. A school that wants them upgrades, which is the
 * outcome worth having.
 */
export const NOT_SOLD_SEPARATELY: readonly ModuleKey[] = [
  MODULES.TASK,
  MODULES.POLL,
  MODULES.DISCUSSION,
  MODULES.FORM,
];

/**
 * The modules a school is paying for ON TOP of its tier.
 *
 * Only `enabled` overrides that the plan does not already include. A module
 * force-enabled and ALSO in the tier is not an add-on and must never be billed
 * twice — that is the single most likely way this goes wrong, since an operator
 * comping a module before an upgrade leaves the override behind.
 */
export function billableAddons(plan: Plan, overrides?: ModuleOverrides): ModuleKey[] {
  const included = new Set(PLAN_MODULES[plan] ?? PLAN_MODULES[DEFAULT_PLAN]);
  // A CANCELLED add-on is still enabled until the period it was paid for runs
  // out, and is never charged again. Excluding it here is the whole of "stop
  // billing me": the renewal quote, the checkout and the auto-renew charge all
  // price through this one function.
  const cancelling = new Set(overrides?.cancelling ?? []);
  return [...new Set(overrides?.enabled ?? [])]
    .filter((m) => !included.has(m))
    .filter((m) => !cancelling.has(m))
    .filter((m) => MODULE_ADDON_PRICING[m] !== undefined);
}

/**
 * Overrides with every CANCELLED add-on actually removed.
 *
 * Called when a renewal rolls the period over — the point at which the time the
 * school paid for has run out. Cancelling stops the billing immediately
 * (`billableAddons`); this is what finally switches the module off, and without
 * it a cancelled add-on would stay enabled for ever, free.
 */
export function dropCancelledAddons(overrides?: ModuleOverrides | null): ModuleOverrides {
  const cancelling = new Set(overrides?.cancelling ?? []);
  if (cancelling.size === 0) return overrides ?? {};
  return {
    enabled: (overrides?.enabled ?? []).filter((m) => !cancelling.has(m)),
    disabled: overrides?.disabled ?? [],
    purchased: (overrides?.purchased ?? []).filter((m) => !cancelling.has(m)),
    cancelling: [],
  };
}

/**
 * The overrides that survive a DELINQUENCY downgrade.
 *
 * When `effectivePlan` drops a school to the floor for non-payment it loses its
 * tier's modules — and used to keep every add-on it had ever bought, because
 * both live in `overrides.enabled` and nothing told them apart. The same
 * non-payment revoking one entitlement and not the other is not a policy, it is
 * an oversight: an add-on is billed at renewal, and there has been no renewal.
 *
 * An operator COMP is the opposite case and is deliberately kept. It is the
 * platform owner's explicit decision about that school, not something the
 * school failed to do, and dunning silently reversing it would surprise the
 * person who made it.
 */
export function overridesUnderDelinquency(overrides?: ModuleOverrides | null): ModuleOverrides {
  const purchased = new Set(overrides?.purchased ?? []);
  return {
    ...overrides,
    enabled: (overrides?.enabled ?? []).filter((m) => !purchased.has(m)),
  };
}

/** Pure: the per-seat monthly cost of a school's add-ons, in minor units. */
export function addonPerSeatMonthlyMinor(plan: Plan, overrides?: ModuleOverrides): number {
  return billableAddons(plan, overrides).reduce((sum, m) => sum + (MODULE_ADDON_PRICING[m] ?? 0), 0);
}

/** Pure: the CHARGED price for a cycle — gross minus the commitment discount
 *  (TERM −5%, YEAR −15%). `pricing` defaults to the platform constants; pass the
 *  operator-resolved effective pricing so overrides flow into quotes and charges.
 *  This ONE function prices every surface: quotes, checkout, homepage, estimates. */
export function computeSubscriptionPriceMinor(
  plan: Plan,
  activeStudents: number,
  cycle: BillingCycle,
  pricing: PlanPricing = PLAN_PRICING,
  overrides?: ModuleOverrides,
): number {
  return applyCycleDiscountMinor(
    computeSubscriptionGrossMinor(plan, activeStudents, cycle, pricing, overrides),
    cycle,
  );
}

/**
 * How many CYCLES a school may buy in one charge.
 *
 * A school that wants several years of access had only one route: pay again,
 * and again, and again. That is worse than tedious — concurrent charges against
 * the same subscription raced each other, so paying four times could buy two
 * periods. Buying N periods in ONE charge is one payment, one period
 * calculation, and one row in the ledger.
 *
 * Capped: 20 periods is 5 academic years at the YEAR cycle, and an unbounded
 * multiplier is a way to mistype a 5 into a 55-year commitment.
 */
/**
 * The largest single charge the ledger will accept, in minor units.
 *
 * The storage ceiling is gone: these columns are BIGINT, so the database can
 * hold ~9.2 x 10^18 minor units. The binding limit is now the application's,
 * not the schema's — money crosses the DB boundary as a JavaScript number,
 * which represents integers exactly only up to 2^53.
 *
 * This sits three orders of magnitude below that, which is not timidity: a
 * single charge of a trillion naira is a data-entry accident or an attack, not
 * a school buying a subscription, and refusing it with a sentence is better
 * than processing it. Gateways impose their own far lower limits anyway.
 *
 * It used to be 2,000,000,000 — just under the int4 ceiling of 2,147,483,647
 * (~NGN 21.4m), which a five-year ENTERPRISE charge and any mid-sized school's
 * monthly payroll both exceeded.
 */
export const MAX_CHARGE_MINOR = 1_000_000_000_000;

export const MAX_BILLING_PERIODS = 20;

/** Narrow an arbitrary input to a usable period count. Absent = 1, so every
 *  existing caller keeps its current meaning. */
export function normalisePeriods(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw ?? 1);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_BILLING_PERIODS, Math.max(1, Math.floor(n)));
}

/**
 * The MONTHS a purchase of `periods` × `cycle` actually buys.
 *
 * The single place that answers "how long is this?", so the price, the period
 * end written at settlement, and the date shown to the school before they pay
 * all come from one rule and cannot drift apart.
 */
export function billedMonths(cycle: BillingCycle, periods = 1): number {
  return CYCLE_MONTHS[cycle] * normalisePeriods(periods);
}

/**
 * The date a purchase made now would run until.
 *
 * Shown to the school BEFORE they pay, because "YEAR" does not mean what a
 * reader assumes: an academic year is 3 terms = 9 BILLED months (holidays are
 * not charged), so a "1 year" purchase runs 9 calendar months. A concrete date
 * removes the ambiguity that no amount of labelling fixes.
 *
 * `from` is the later of now and the current period end — the same rule
 * settlement uses to stack a renewal, so the quote cannot promise a date the
 * settlement then disagrees with.
 */
export function periodEndAfter(
  cycle: BillingCycle,
  periods: number,
  now: Date,
  currentPeriodEnd?: Date | null,
): Date {
  const base = currentPeriodEnd && currentPeriodEnd > now ? new Date(currentPeriodEnd) : new Date(now);
  const end = new Date(base);
  end.setMonth(end.getMonth() + billedMonths(cycle, periods));
  return end;
}

// --- Mid-cycle upgrade proration + seat true-up --------------------------------

/** Pure: fraction of the paid period still ahead (0..1). The paid period is
 *  approximated as CYCLE_MONTHS × 30 days ending at periodEnd — one deterministic
 *  rule for credit AND true-up so the two can never disagree. */
export function remainingPeriodRatio(cycle: BillingCycle, periodEnd: Date, now: Date): number {
  const periodMs = CYCLE_MONTHS[cycle] * 30 * 24 * 3600 * 1000;
  const remainingMs = periodEnd.getTime() - now.getTime();
  if (remainingMs <= 0 || periodMs <= 0) return 0;
  return Math.min(1, remainingMs / periodMs);
}

/** Pure: the unused-time credit when a school switches plan mid-period — the
 *  remaining fraction of what they LAST PAID (never more than they paid; zero
 *  when lapsed or never paid). Deducted from the upgrade charge at checkout. */
export function prorationCreditMinor(
  lastPriceMinor: number | null,
  cycle: BillingCycle,
  periodEnd: Date | null,
  now: Date,
): number {
  if (!lastPriceMinor || lastPriceMinor <= 0 || !periodEnd) return 0;
  return Math.min(lastPriceMinor, Math.round(lastPriceMinor * remainingPeriodRatio(cycle, periodEnd, now)));
}

/**
 * Pure: what ONE add-on costs to buy mid-period — the module's per-seat rate for
 * the seats a school has, prorated to the time left before renewal.
 *
 * PRORATED, NOT A FULL PERIOD. A school buying the exam hall three weeks before
 * renewal should pay for three weeks; charging a full cycle for four days of use
 * is the kind of bill that produces a chargeback rather than a renewal. From the
 * next renewal it is billed in full with everything else.
 *
 * Returns null when there is nothing sensible to charge — no active period, no
 * price, or an amount below the gateway's floor. Null means "give it to them for
 * the rest of this period and start billing at renewal", which is both kinder
 * and cheaper than a failed charge.
 */
export function addonProrationMinor(
  perSeatMonthlyMinor: number | null | undefined,
  seats: number,
  cycle: BillingCycle,
  periodEnd: Date | null,
  now: Date,
): number | null {
  if (!perSeatMonthlyMinor || perSeatMonthlyMinor <= 0 || !periodEnd) return null;
  const billableSeats = Math.max(1, Math.floor(seats));
  const full = perSeatMonthlyMinor * billableSeats * CYCLE_MONTHS[cycle];
  const amount = Math.round(full * remainingPeriodRatio(cycle, periodEnd, now));
  return amount < MIN_CHARGE_MINOR ? null : amount;
}

/** Gateways refuse zero/near-zero charges — the floor for a credited upgrade. */
export const MIN_CHARGE_MINOR = 10_000; // ₦100 in kobo

/** Pure: what a mid-period seat true-up costs — the EXTRA seats at the plan's
 *  cycle price, prorated to the time left. Null when nothing is owed. */
export function computeTrueUpMinor(
  plan: Plan,
  billedSeats: number | null,
  currentSeats: number,
  cycle: BillingCycle,
  periodEnd: Date | null,
  now: Date,
  pricing: PlanPricing = PLAN_PRICING,
): { extraSeats: number; amountMinor: number } | null {
  if (!periodEnd || billedSeats == null || billedSeats <= 0) return null;
  const extraSeats = currentSeats - billedSeats;
  if (extraSeats <= 0) return null;
  const ratio = remainingPeriodRatio(cycle, periodEnd, now);
  if (ratio <= 0) return null;
  const amountMinor = Math.round(computeSubscriptionPriceMinor(plan, extraSeats, cycle, pricing) * ratio);
  if (amountMinor < MIN_CHARGE_MINOR) return null; // not worth a charge yet
  return { extraSeats, amountMinor };
}

/**
 * Pure: seat-arrears accrual — the metered cost of students ABOVE the billed
 * seat count for an elapsed window. Rate = the plan's per-seat MONTHLY price /
 * 30 per day, times fractional days. This is the anti-leak for mid-period
 * growth: delay no longer discounts the top-up (the old forward-only quote
 * shrank as the term ran down); the meter just keeps counting seat-days until
 * it is settled — voluntarily via top-up, or automatically at the next renewal.
 * Billed seats are a FLOOR: a shrinking roster accrues nothing (no credits).
 */
export function accrueSeatArrearsMinor(
  plan: Plan,
  billedSeats: number | null,
  currentSeats: number,
  elapsedMs: number,
  pricing: PlanPricing = PLAN_PRICING,
): number {
  if (billedSeats == null || billedSeats <= 0 || elapsedMs <= 0) return 0;
  const extraSeats = currentSeats - billedSeats;
  if (extraSeats <= 0) return 0;
  const perSeatDaily = pricing[plan].perSeatMonthlyMinor / 30;
  const days = elapsedMs / (24 * 3600 * 1000);
  return Math.round(extraSeats * perSeatDaily * days);
}

/** How a platform subscription payment changes the subscription when it settles. */
export const SUBSCRIPTION_PAYMENT_KINDS = {
  /** Same plan again: EXTENDS currentPeriodEnd (renewals stack). */
  RENEWAL: "RENEWAL",
  /** Plan change: period RESTARTS from now (the unused time was credited at checkout). */
  UPGRADE: "UPGRADE",
  /** Seat top-up: seats update; the period does NOT move. */
  TRUEUP: "TRUEUP",
  /** A single module bought on its own: the override is added and the period
   *  does NOT move. It renews with the subscription from then on. */
  ADDON: "ADDON",
} as const;
export type SubscriptionPaymentKind = (typeof SUBSCRIPTION_PAYMENT_KINDS)[keyof typeof SUBSCRIPTION_PAYMENT_KINDS];

/**
 * Pure: the plan a school is ENTITLED to right now. An ACTIVE school gets its
 * purchased `plan`. A PAST_DUE school keeps it through a grace window past the
 * period end, then falls back to the STANDARD floor. A CANCELED school keeps it only until
 * the period end. The stored `plan` is never mutated — paying restores it.
 */
export function effectivePlan(
  plan: Plan,
  status: SubscriptionStatus,
  currentPeriodEnd: Date | null,
  graceDays: number = SUBSCRIPTION_GRACE_DAYS,
  now: Date = new Date(),
): Plan {
  if (status === SUBSCRIPTION_STATUS.ACTIVE) return plan;
  if (!currentPeriodEnd) return FALLBACK_PLAN;
  const grace = status === SUBSCRIPTION_STATUS.PAST_DUE ? graceDays : 0;
  const cutoff = new Date(currentPeriodEnd.getTime() + grace * 24 * 60 * 60 * 1000);
  return now > cutoff ? FALLBACK_PLAN : plan;
}

// ---------------------------------------------------------------------------
// What a platform charge was FOR, in a sentence
// ---------------------------------------------------------------------------
/**
 * A human description of one platform-subscription payment.
 *
 * The operator's revenue ledger rendered `plan`, `billingCycle` and `kind` as
 * three columns of raw enum codes — `ENTERPRISE`, `TERM`, `TRUEUP` — and left a
 * finance reader to reconstruct what was actually sold. Worse for an add-on:
 * every one read `ADDON`, and the row carries `addonModule` saying WHICH module
 * was bought, which nothing displayed. A ledger line whose purpose you have to
 * infer is a ledger line nobody can audit.
 *
 * PURE, and shared: the ledger table, the CSV export and any receipt must say
 * the same thing about the same row, and three call sites writing their own
 * sentence is how they stop agreeing.
 */
export function describePlatformCharge(input: {
  kind: string;
  plan: string;
  billingCycle: string;
  /** How many cycles this one charge bought. 1 is the ordinary case. */
  billingPeriods?: number;
  /** Set only on an ADDON charge: the module that was bought. */
  addonModule?: string | null;
  seats?: number;
  promoCode?: string | null;
}): string {
  const cycle = input.billingCycle?.toLowerCase() || "period";
  const periods = Math.max(1, input.billingPeriods ?? 1);
  const span = periods > 1 ? `${periods} ${cycle}s` : `1 ${cycle}`;
  const seats = typeof input.seats === "number" && input.seats > 0 ? ` · ${input.seats} seats` : "";
  const promo = input.promoCode ? ` · promo ${input.promoCode}` : "";
  const moduleLabel = input.addonModule
    ? MODULE_CATALOG.find((m) => m.key === input.addonModule)?.label ?? input.addonModule
    : null;

  switch (input.kind) {
    case SUBSCRIPTION_PAYMENT_KINDS.RENEWAL:
      return `${input.plan} subscription · ${span}${seats}${promo}`;
    case SUBSCRIPTION_PAYMENT_KINDS.UPGRADE:
      // An upgrade RESTARTS the period from now, having credited the unused
      // time at checkout — worth saying, because the tenor beside it will not
      // line up with the previous row's and that looks like an error otherwise.
      return `Plan change to ${input.plan} · ${span} from today${seats}${promo}`;
    case SUBSCRIPTION_PAYMENT_KINDS.TRUEUP:
      // A true-up moves SEATS and never the period, so its tenor is the
      // subscription's existing one rather than anything this charge bought.
      return `Seat top-up on ${input.plan}${seats ? ` · now ${input.seats} seats` : ""} · period unchanged`;
    case SUBSCRIPTION_PAYMENT_KINDS.ADDON:
      return moduleLabel
        ? `Add-on: ${moduleLabel} · prorated to the current period${promo}`
        : `Module add-on · prorated to the current period${promo}`;
    default:
      return `${input.plan} · ${input.kind}${seats}${promo}`;
  }
}

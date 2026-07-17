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
const STANDARD_MODULES: ModuleKey[] = [
  MODULES.LMS, MODULES.GRADEBOOK, MODULES.ATTENDANCE, MODULES.TIMETABLE, MODULES.MESSAGING, MODULES.CALENDAR,
  MODULES.SIS, MODULES.LIBRARY,
];
const PREMIUM_ADDS: ModuleKey[] = [
  MODULES.FEES, MODULES.DOCUMENTS, MODULES.WORKFLOW, MODULES.ANALYTICS, MODULES.INTEGRITY,
  MODULES.TASK, MODULES.POLL, MODULES.DISCUSSION, MODULES.FORM, MODULES.CERTIFICATE,
];
const ULTIMATE_ADDS: ModuleKey[] = [
  MODULES.ADMISSIONS, MODULES.HOSTEL, MODULES.TRANSPORT, MODULES.DISCIPLINE, MODULES.ALUMNI,
];
const ENTERPRISE_ADDS: ModuleKey[] = [MODULES.HR, MODULES.GAMES];

/** The module bundle each named tier includes (before per-school overrides). */
export const PLAN_MODULES: Record<Plan, ModuleKey[]> = {
  // Core teaching essentials for any school.
  STANDARD: STANDARD_MODULES,
  // Adds money handling, engagement, and quality tooling.
  PREMIUM: [...STANDARD_MODULES, ...PREMIUM_ADDS],
  // Adds facilities + student-lifecycle modules.
  ULTIMATE: [...STANDARD_MODULES, ...PREMIUM_ADDS, ...ULTIMATE_ADDS],
  // The complete enterprise suite (HR/payroll + games).
  ENTERPRISE: [...STANDARD_MODULES, ...PREMIUM_ADDS, ...ULTIMATE_ADDS, ...ENTERPRISE_ADDS],
};

/** The lowest tier — the floor a delinquent school falls back to. */
export const FALLBACK_PLAN: Plan = PLANS.STANDARD;

/** Per-school deviations from the tier bundle (force-on / force-off). */
export interface ModuleOverrides {
  enabled?: ModuleKey[];
  disabled?: ModuleKey[];
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
export const CURRENCIES = {
  NGN: "NGN",
  USD: "USD",
} as const;
export type Currency = (typeof CURRENCIES)[keyof typeof CURRENCIES];
export function isCurrency(v: unknown): v is Currency {
  return v === CURRENCIES.NGN || v === CURRENCIES.USD;
}
export const CURRENCY_SYMBOL: Record<Currency, string> = { NGN: "₦", USD: "$" };

/** Which currencies a tier may be quoted/sold in. ENTERPRISE is USD-ONLY — it
 *  targets international schools and is indicated in dollars EVERYWHERE
 *  (homepage, quotes, checkout, operator pricing). */
export function planCurrencies(plan: Plan): Currency[] {
  return plan === PLANS.ENTERPRISE ? [CURRENCIES.USD] : [CURRENCIES.NGN, CURRENCIES.USD];
}
/** The currency a tier is DISPLAYED in by default (₦ locally, $ for ENTERPRISE). */
export function defaultCurrencyFor(plan: Plan): Currency {
  return plan === PLANS.ENTERPRISE ? CURRENCIES.USD : CURRENCIES.NGN;
}

/** Per-seat monthly pricing by tier, in ONE currency's minor unit (kobo/cents). */
export type PlanPricing = Record<Plan, { perSeatMonthlyMinor: number }>;
/** Per-currency pricing tables. */
export type MultiCurrencyPlanPricing = Record<Currency, PlanPricing>;

/**
 * DEFAULT per-seat (per active student) price each MONTH, in kobo, by tier.
 * STANDARD is the entry tier (and the delinquency floor); higher tiers cost more
 * per seat. These are the FALLBACK values — the super_admin can override any
 * (tier, currency) price via the operator console (stored in the global
 * `plan_price` table); `PlanPricingService.effective()` merges those rows over
 * these constants, and everything that quotes or charges (billing overview,
 * checkout, the public landing page) reads the merged result.
 * NOTE: an ENTERPRISE NGN entry exists to keep the Record type total, but the
 * tier is never quoted/sold in NGN — `planCurrencies` gates every surface.
 */
export const PLAN_PRICING: PlanPricing = {
  STANDARD: { perSeatMonthlyMinor: 20_000 }, // ₦200 / student / month
  PREMIUM: { perSeatMonthlyMinor: 35_000 }, // ₦350 / student / month
  ULTIMATE: { perSeatMonthlyMinor: 50_000 }, // ₦500 / student / month
  ENTERPRISE: { perSeatMonthlyMinor: 75_000 }, // (unsellable in NGN — see note)
};

/** USD defaults, in cents. ENTERPRISE is sold ONLY in USD. */
export const PLAN_PRICING_USD: PlanPricing = {
  STANDARD: { perSeatMonthlyMinor: 25 }, // $0.25 / student / month
  PREMIUM: { perSeatMonthlyMinor: 40 }, // $0.40 / student / month
  ULTIMATE: { perSeatMonthlyMinor: 60 }, // $0.60 / student / month
  ENTERPRISE: { perSeatMonthlyMinor: 100 }, // $1.00 / student / month
};

export const PLAN_PRICING_BY_CURRENCY: MultiCurrencyPlanPricing = {
  NGN: PLAN_PRICING,
  USD: PLAN_PRICING_USD,
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
): number {
  const seats = Math.max(1, Math.floor(activeStudents));
  return pricing[plan].perSeatMonthlyMinor * seats * CYCLE_MONTHS[cycle];
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
): number {
  return applyCycleDiscountMinor(computeSubscriptionGrossMinor(plan, activeStudents, cycle, pricing), cycle);
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

/** How a platform subscription payment changes the subscription when it settles. */
export const SUBSCRIPTION_PAYMENT_KINDS = {
  /** Same plan again: EXTENDS currentPeriodEnd (renewals stack). */
  RENEWAL: "RENEWAL",
  /** Plan change: period RESTARTS from now (the unused time was credited at checkout). */
  UPGRADE: "UPGRADE",
  /** Seat top-up: seats update; the period does NOT move. */
  TRUEUP: "TRUEUP",
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

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
];

export const PLANS = {
  BASIC: "BASIC",
  STANDARD: "STANDARD",
  ENTERPRISE: "ENTERPRISE",
} as const;

export type Plan = (typeof PLANS)[keyof typeof PLANS];

/** The module bundle each named tier includes (before per-school overrides). */
export const PLAN_MODULES: Record<Plan, ModuleKey[]> = {
  // Core teaching essentials.
  BASIC: [MODULES.LMS, MODULES.GRADEBOOK, MODULES.ATTENDANCE, MODULES.TIMETABLE, MODULES.MESSAGING, MODULES.CALENDAR],
  // Full school operations.
  STANDARD: [
    MODULES.LMS, MODULES.GRADEBOOK, MODULES.ATTENDANCE, MODULES.TIMETABLE, MODULES.MESSAGING, MODULES.CALENDAR,
    MODULES.SIS, MODULES.FEES, MODULES.DOCUMENTS, MODULES.WORKFLOW, MODULES.ANALYTICS, MODULES.INTEGRITY,
    MODULES.ADMISSIONS,
  ],
  // Everything.
  ENTERPRISE: [
    MODULES.LMS, MODULES.GRADEBOOK, MODULES.ATTENDANCE, MODULES.TIMETABLE, MODULES.MESSAGING, MODULES.CALENDAR,
    MODULES.SIS, MODULES.FEES, MODULES.DOCUMENTS, MODULES.WORKFLOW, MODULES.ANALYTICS, MODULES.INTEGRITY,
    MODULES.ADMISSIONS, MODULES.HR, MODULES.GAMES,
  ],
};

/** Per-school deviations from the tier bundle (force-on / force-off). */
export interface ModuleOverrides {
  enabled?: ModuleKey[];
  disabled?: ModuleKey[];
}

/**
 * A school with no subscription row defaults to ENTERPRISE (everything on), so
 * the entitlement layer is purely opt-in to RESTRICT — it never silently breaks
 * an existing tenant that predates a subscription record.
 */
export const DEFAULT_PLAN: Plan = PLANS.ENTERPRISE;

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
// `effectivePlan` drops to BASIC while past-due-beyond-grace, so a payment
// instantly restores the paid tier without re-resolving overrides.

export const BILLING_CYCLES = {
  MONTH: "MONTH",
  TERM: "TERM",
  YEAR: "YEAR",
} as const;
export type BillingCycle = (typeof BILLING_CYCLES)[keyof typeof BILLING_CYCLES];

/** Months billed per cycle (a Nigerian school TERM ≈ 4 months, 3 terms/year). */
export const CYCLE_MONTHS: Record<BillingCycle, number> = {
  MONTH: 1,
  TERM: 4,
  YEAR: 12,
};

export function isBillingCycle(value: string): value is BillingCycle {
  return (Object.values(BILLING_CYCLES) as string[]).includes(value);
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

/**
 * Per-seat (per active student) price each MONTH, in kobo, by tier. BASIC is the
 * free floor a delinquent school falls back to, so it is ₦0 — the entitlement
 * layer can ALWAYS downgrade to it without owing a charge.
 */
export const PLAN_PRICING: Record<Plan, { perSeatMonthlyMinor: number }> = {
  BASIC: { perSeatMonthlyMinor: 0 },
  STANDARD: { perSeatMonthlyMinor: 20_000 }, // ₦200 / student / month
  ENTERPRISE: { perSeatMonthlyMinor: 35_000 }, // ₦350 / student / month
};

/** Days a school keeps its paid plan after period end before the dunning downgrade. */
export const SUBSCRIPTION_GRACE_DAYS = 7;
/** Days before period end to send a renewal reminder (2 weeks). */
export const RENEWAL_REMINDER_DAYS = 14;

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

/** Pure: price to run `plan` for `activeStudents` over one `cycle` (minor units). */
export function computeSubscriptionPriceMinor(
  plan: Plan,
  activeStudents: number,
  cycle: BillingCycle,
): number {
  const seats = Math.max(1, Math.floor(activeStudents));
  return PLAN_PRICING[plan].perSeatMonthlyMinor * seats * CYCLE_MONTHS[cycle];
}

/**
 * Pure: the plan a school is ENTITLED to right now. An ACTIVE school gets its
 * purchased `plan`. A PAST_DUE school keeps it through a grace window past the
 * period end, then falls back to BASIC. A CANCELED school keeps it only until
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
  if (!currentPeriodEnd) return PLANS.BASIC;
  const grace = status === SUBSCRIPTION_STATUS.PAST_DUE ? graceDays : 0;
  const cutoff = new Date(currentPeriodEnd.getTime() + grace * 24 * 60 * 60 * 1000);
  return now > cutoff ? PLANS.BASIC : plan;
}

// =============================================================================
// Group console — cross-campus aggregates for multi-school proprietors
// =============================================================================
// AGGREGATES ONLY. Counts, sums and percentages cross a tenant boundary here;
// no pupil, no staff member and no record ever does. A director sees how each
// campus is doing, never who is in it.
// =============================================================================

/**
 * Money at one campus, in ONE currency.
 *
 * A list rather than a pair of numbers because the platform bills in NGN and USD,
 * and adding them produces a figure that is wrong in both. The console previously
 * summed `amountMinor` across every campus with no currency in the query, and the
 * page printed the result with a ₦ in front of it.
 */
export interface GroupMoneyDto {
  /** ISO code — NGN, USD. */
  currency: string;
  /** POSTED payments received in the selected period. */
  collectedMinor: number;
  /** Issued and part-paid invoices, less what has been paid against them. */
  outstandingMinor: number;
}

/** Why a campus is flagged for the director's attention. */
export const GROUP_FLAGS = [
  /** School disabled — nobody there can sign in. */
  "DISABLED",
  /** Subscription is not ACTIVE (past due or cancelled). */
  "BILLING",
  /** Has pupils but took no register in the whole period. */
  "NO_REGISTERS",
  /** Attendance below the acceptable line for the period. */
  "LOW_ATTENDANCE",
  /** Nobody holds a staff account — the campus has no one to run it. */
  "NO_STAFF",
] as const;
export type GroupFlag = (typeof GROUP_FLAGS)[number];

export interface GroupSchoolStatsDto {
  schoolId: string;
  name: string;
  slug: string;
  active: boolean;
  /** Pupils holding the student ROLE — the same definition as the billing seat
   *  count and the operator console, so the three cannot disagree. */
  students: number;
  /** DISTINCT staff: everyone whose role is not student/parent, counted as PEOPLE.
   *  It used to count `employee` rows — employment RECORDS — so a campus that had
   *  not filled in its HR register reported zero staff while employing forty. */
  staff: number;
  /** Present % across the selected period; null when no register was taken. */
  attendancePct: number | null;
  /** Registers actually taken in the period — distinguishes "poor attendance"
   *  from "nobody recorded anything", which are different problems. */
  registersTaken: number;
  /** One entry per currency in use at this campus. Usually exactly one. */
  money: GroupMoneyDto[];
  plan: string;
  subscriptionStatus: string;
  currentPeriodEnd: Date | null;
  /** Conditions worth the director's attention, worst first. */
  flags: GroupFlag[];
}

/** A group the caller directs. Directors of several see a picker. */
export interface GroupRefDto {
  id: string;
  name: string;
  schools: number;
}

/** The window the figures cover. */
export interface GroupPeriodDto {
  from: Date;
  to: Date;
  /** Plain-language name for the header: "This term", "This month", "Today". */
  label: string;
  key: string;
}

export interface GroupOverviewDto {
  groupId: string;
  groupName: string;
  /** EVERY group the caller directs — the console used to show only the first,
   *  silently, so a proprietor with two chains saw half their business. */
  groups: GroupRefDto[];
  period: GroupPeriodDto;
  schools: GroupSchoolStatsDto[];
  totals: {
    students: number;
    staff: number;
    /** Keyed by ISO currency. Never a single number: see GroupMoneyDto. */
    byCurrency: Record<string, { collectedMinor: number; outstandingMinor: number }>;
  };
  /** Campuses carrying at least one flag. */
  flagged: number;
}

// --- per-campus drill-down ---------------------------------------------------

/** One month of a campus's history. */
export interface GroupTrendPointDto {
  /** YYYY-MM. */
  month: string;
  /**
   * Collected that month, in the campus's OWN currency — see `trendCurrency`.
   *
   * It used to sum `payment.amountMinor` across every currency, in the same
   * file whose `moneyByCampus` joins through to the invoice and explains why:
   * "a payment carries no currency of its own — it inherits its INVOICE's ...
   * precisely the assumption that made the old totals wrong". One line drawn
   * on a chart cannot be two currencies, so this one is restricted rather than
   * split; the per-currency figures are on the campus's money block.
   */
  collectedMinor: number;
  attendancePct: number | null;
}

/**
 * One campus in depth, for a director who wants to know WHY a row looks wrong.
 *
 * Still aggregates only: monthly totals, status counts, headcount. A director is
 * not a member of staff at that campus and never sees a named pupil, an invoice,
 * or a record — those stay behind that school's own permissions.
 */
export interface GroupSchoolDetailDto {
  schoolId: string;
  name: string;
  slug: string;
  active: boolean;
  groupName: string;
  students: number;
  staff: number;
  parents: number;
  classes: number;
  /** Last 6 months, oldest first. */
  trend: GroupTrendPointDto[];
  /** The currency `trend[].collectedMinor` is drawn in: the campus's own. */
  trendCurrency: string;
  /** Invoice counts by status — where the money is stuck. */
  invoicesByStatus: Record<string, number>;
  money: GroupMoneyDto[];
  plan: string;
  subscriptionStatus: string;
  currentPeriodEnd: Date | null;
  flags: GroupFlag[];
}

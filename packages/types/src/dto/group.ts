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
  /**
   * NET settled against invoices in the selected period: POSTED payments, with
   * a REFUND subtracting — the same "paid" the campus's own finance report and
   * every invoice balance use (`netPaidOf`). It used to count kind PAYMENT only,
   * so a refund never came off and credit or scholarship never went on.
   */
  collectedMinor: number;
  /**
   * What families owe NOW: the sum of each open invoice's POSITIVE balance
   * (total less net paid). Not windowed — a debt does not stop being owed
   * because it was billed last term. It used to subtract PAYMENT-kind money
   * only, and netted the whole campus at once, so one overpaid invoice hid
   * another family's debt.
   */
  outstandingMinor: number;
}

/**
 * The windows a director can pick. ONE list, read by the API and the page, so
 * the label on the button and the label on the figures cannot drift apart.
 * Each campus is measured over the window in its OWN calendar — "today" in
 * Lagos and "today" in Toronto are different days.
 */
export const GROUP_PERIODS = [
  { key: "today", label: "Today", short: "Today" },
  { key: "week", label: "Last 7 days", short: "7 days" },
  { key: "month", label: "This month", short: "This month" },
  // A term is per-school and need not align across campuses, so the group view
  // uses a fixed 90-day window and SAYS so rather than pretending otherwise.
  { key: "term", label: "Last 90 days", short: "90 days" },
] as const;
export type GroupPeriodKey = (typeof GROUP_PERIODS)[number]["key"];
export const DEFAULT_GROUP_PERIOD: GroupPeriodKey = "month";

/**
 * Below this, a campus's attendance rate is flagged. One constant: the service
 * raised the flag at 85 and both pages coloured the figure red at a separately
 * typed 85, which is a threshold waiting to disagree with its own flag.
 */
export const GROUP_LOW_ATTENDANCE_PCT = 85;

/**
 * `subscriptionStatus` for a campus with NO subscription row. It used to read
 * as "ACTIVE", hiding the gap; the platform resolves such a school to the
 * STANDARD floor (fail-closed), so the console must say it is not paid up.
 */
export const GROUP_NO_SUBSCRIPTION = "NONE";

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

/** What each flag says on screen — ONE wording for the list and the campus page,
 *  which used to print the raw enum lower-cased on one and a label on the other.
 *  A `Record` over the union, so a new flag without a label fails to compile. */
export const GROUP_FLAG_LABELS: Record<GroupFlag, string> = {
  DISABLED: "Disabled",
  BILLING: "Billing",
  NO_STAFF: "No staff",
  NO_REGISTERS: "No registers",
  LOW_ATTENDANCE: "Low attendance",
};

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
  /** Attendance rate across the selected period by the platform's ONE rule
   *  (`attendanceRatePct`: present + late, EXCUSED is an absence); null when no
   *  register was taken. */
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
  /** Earliest campus start, as an instant. Each campus is measured from
   *  midnight in its OWN zone, so across a group this is the envelope. */
  from: Date;
  to: Date;
  /** Plain-language name for the header: "This month", "Last 7 days", "Today". */
  label: string;
  key: GroupPeriodKey;
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
  /** The window the flags and figures cover — the SAME one the overview row was
   *  computed over, so the page can say which and the two can be compared. */
  period: GroupPeriodDto;
  /**
   * The figures the FLAGS below were computed from, over the selected period.
   *
   * The campus page carried a `LOW_ATTENDANCE` flag and no percentage: a
   * director was told a campus needed attention and shown nothing to judge it
   * by, on the one page they open to find out why. Same shape as the rule that
   * an approver must be able to see what the decision turns on.
   */
  attendancePct: number | null;
  registersTaken: number;
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

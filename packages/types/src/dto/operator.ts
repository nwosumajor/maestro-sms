// Super-admin operator console response DTOs.

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
  /** Everyone with an account: students + staff + guardians. Kept for continuity,
   *  but it is the least useful of the four — a 900-pupil school and one with 900
   *  guardian accounts produce the same number. */
  users: number;
  /** Pupils holding the student ROLE — the SAME definition as the billing seat
   *  count, so this figure reconciles against what the school is charged for. */
  students: number;
  /** DISTINCT staff: everyone whose role is not student/parent. Counts people, not
   *  role assignments — a head teacher who also teaches is one member of staff. */
  staff: number;
  /** Guardian accounts. */
  parents: number;
  /** Subscription plan (STANDARD | PREMIUM | ULTIMATE | ENTERPRISE). */
  plan: string;
  /** Count of subscription-enabled modules. */
  moduleCount: number;
  /** Per-school grace override (days); null -> platform default. */
  graceDays: number | null;
  /** Billing status (ACTIVE | PAST_DUE | CANCELED). */
  subscriptionStatus: string;
}

/** Paged tenant registry (the operator console at 500+ schools needs search /
 *  filter / pagination — both for the UI and because each listed tenant costs
 *  per-school enrichment queries). */
export interface TenantPageDto {
  tenants: TenantDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Lightweight id+name list for pickers (e.g. add-admin-to-school). */
export interface TenantNameDto {
  id: string;
  name: string;
}

/** A single user as seen by the super_admin cross-tenant directory. */
export interface OperatorUserDto {
  id: string;
  uniqueId: string;
  name: string;
  email: string;
  /** Role names the user holds in this school. */
  roles: string[];
  /** Account status (ACTIVE | DISABLED). DISABLED blocks login. */
  status: string;
  /** Whether the user has confirmed/enabled TOTP MFA. */
  mfaEnabled: boolean;
  /** Whether the platform owner mandates MFA enrolment for this user. */
  mfaRequired: boolean;
  /** True when the account is locked after 3 failed logins (super_admin reactivates). */
  locked: boolean;
  /** When the account was locked (record only; the lock is permanent until cleared). */
  lockedUntil: Date | null;
}

/** A recent platform-subscription payment for the operator revenue feed. */
export interface PlatformRevenueEntryDto {
  schoolName: string;
  plan: string;
  amountMinor: number;
  /** What money `amountMinor` is. The row carried the figure and not the
   *  currency, so a dollar renewal rendered in the preview under a naira sign. */
  currency: string;
  status: string;
  createdAt: Date;
}

/** Cross-tenant business metrics for the platform owner (super_admin). All figures
 *  span EVERY customer school (the platform org itself is excluded). Money is in
 *  integer minor units (NGN kobo). */
export interface PlatformAnalyticsDto {
  /** Customer schools (the platform org is never counted). */
  schools: { total: number; active: number; disabled: number };
  /** Customer-school counts keyed by effective plan (STANDARD|PREMIUM|ULTIMATE|ENTERPRISE). */
  schoolsByPlan: Record<string, number>;
  /** Customer-school counts keyed by subscription status (ACTIVE|PAST_DUE|CANCELED). */
  schoolsByStatus: Record<string, number>;
  /** People across all customer schools. */
  people: { students: number; staff: number };
  /**
   * Revenue from PAID platform-subscription payments (all time), in the
   * PLATFORM'S HOME currency only — anything sold in another currency is real
   * revenue and belongs on the per-currency ledger at /operator/payments, never
   * added into this figure. `currency` names it rather than leaving the reader
   * to infer it from the DTO's own header comment.
   */
  revenue: { paidTotalMinor: number; payments: number; last30dMinor: number; currency: string };
  /** Onboarding intake pipeline (public requests) keyed by status. */
  onboardingPipeline: Record<string, number>;
  /** The most recent platform-subscription payments (newest first, capped). */
  recentPayments: PlatformRevenueEntryDto[];

  // --- decision-grade SaaS metrics (super_admin) ---
  /**
   * Monthly recurring revenue: normalised per-seat run-rate of ACTIVE subscriptions.
   *
   * `totalMinor`, `byPlan` and `arpaMinor` are the platform's HOME currency, and
   * `byCurrency` carries every other market — money is never summed across
   * currencies, the rule the payments block twenty lines down already states at
   * length ("kobo added to cents, which is not money in any currency"). This
   * roll-up did exactly that, from a hard-coded naira table, thirty lines ABOVE
   * the fix that says so.
   */
  mrr: {
    totalMinor: number;
    byPlan: Record<string, number>;
    arpaMinor: number;
    payingSchools: number;
    /** Every currency with an active subscription, home currency included. */
    byCurrency: { currency: string; totalMinor: number; payingSchools: number }[];
  };
  /**
   * Monthly trend (chronological, last ~6 months) for growth + revenue charts.
   *
   * `revenueMinor` is the HOME currency, matching `revenue` above. It used to
   * add every currency — twenty-five lines below the loop that deliberately
   * does not, and which explains at length why: "kobo added to cents ... a bug
   * with a start date". Same bug, same start date, on the chart beside it.
   */
  growth: { month: string; schools: number; students: number; revenueMinor: number }[];
  /** Acquisition funnel: public requests → approved → provisioned schools → paying. */
  funnel: { requests: number; approved: number; provisioned: number; paying: number };
  /** Churn / delinquency signals for retention decisions. `atRiskMrrMinor` is
   *  the HOME currency; `atRiskByCurrency` carries the rest. */
  risk: {
    pastDue: number;
    canceled: number;
    atRiskMrrMinor: number;
    atRiskByCurrency: { currency: string; totalMinor: number }[];
  };
  /** How widely each product module is switched on (informs product investment). */
  moduleAdoption: { key: string; label: string; schools: number }[];
  /** Largest customer schools by enrolment (with their plan + MRR contribution).
   *  `mrrCurrency` is the school's OWN subscription currency — the figure was
   *  computed from the naira table for every school whatever it is billed in. */
  topSchools: { name: string; students: number; plan: string; mrrMinor: number; mrrCurrency: string }[];
  /** Portfolio averages. */
  averages: { studentsPerSchool: number; modulesPerSchool: number };
  /** Platform-wide student demographics from profiles (every customer school). */
  demographics: { profiled: number; gender: Record<string, number>; ageBand: Record<string, number> };
}

/** A single cross-tenant audit entry for the super_admin platform audit console.
 *  The actor is fully identified (email + unique id + roles) for investigation. */
export interface PlatformAuditEntryDto {
  id: string;
  createdAt: Date;
  schoolId: string;
  schoolName: string;
  actorId: string;
  actorName: string;
  actorEmail: string;
  actorUniqueId: string;
  actorRoles: string[];
  action: string;
  entity: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
}

/** A page of audit entries + a keyset cursor for the next page (null = last page). */
export interface PlatformAuditPageDto {
  entries: PlatformAuditEntryDto[];
  nextCursor: string | null;
}

/** A lapsed tenant on the operator's red billing banner (GET /operator/billing-alerts). */
export interface OperatorBillingAlertDto {
  schoolId: string;
  name: string;
  slug: string;
  plan: string;
  currentPeriodEnd: Date | null;
  /** Whole days past the paid period end. */
  daysPastDue: number;
  /** True once past the grace window — the school is limited to the Standard floor. */
  downgraded: boolean;
}

/** A tenant ADMIN_APPOINTMENT (junior-admin maker-checker grant) on the
 *  operator's cross-tenant oversight list (GET /operator/admin-appointments). */
export interface OperatorAdminAppointmentDto {
  requestId: string;
  schoolId: string;
  schoolName: string;
  /** Workflow state: PENDING_REVIEW (awaiting the school's second senior) or terminal. */
  state: string;
  roleName: string;
  targetUserName: string | null;
  targetUserEmail: string | null;
  initiatorName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An enrolled student as seen by the super_admin cross-tenant student view. */
export interface OperatorStudentDto {
  id: string;
  uniqueId: string;
  name: string;
  email: string;
  admissionNumber: string | null;
  /** Class names the student is actively enrolled in. */
  classes: string[];
}

/** A platform STAFF member (manager_admin) — the owner's employed help. */
export interface PlatformStaffDto {
  id: string;
  email: string;
  name: string;
  /** ACTIVE | DISABLED — DISABLED blocks every login. */
  status: string;
  mfaEnabled: boolean;
  /** Has the invite actually been used yet (password set)? */
  activated: boolean;
  createdAt: Date;
  /** When access was revoked — null while active. Kept (not deleted) so
   *  "who had access, and until when" stays answerable. */
  disabledAt: Date | null;
  /** Last SUCCESSFUL sign-in. Null means "not since sign-in tracking shipped",
   *  which is NOT the same as never — the console says which. */
  lastLoginAt: Date | null;
  /** Locked out by failed logins; only the owner can reactivate. */
  locked: boolean;
  /** Duties currently LENT to this manager — the whole point of the console.
   *  Standing role permissions are the bare floor and are not listed here. */
  duties: PlatformStaffDutyDto[];
}

/** One live delegation, as the staff console shows it. */
export interface PlatformStaffDutyDto {
  id: string;
  permission: string;
  reason: string;
  expiresAt: Date;
  /** Negative once elapsed; the console flags those rather than hiding them. */
  daysLeft: number;
}

/**
 * What the owner gets back after hiring, or after re-issuing an invite.
 *
 * The LINK is returned deliberately. Hiring used to send an email and return
 * nothing usable — and `EmailService` reports success when it is unconfigured, so
 * a manager could be created that nobody on earth could sign in as, with every
 * step reporting success. The owner is step-up authenticated and is the one
 * person entitled to hand this over, so they get it. Still never a password: the
 * link is single-use and expires.
 */
export interface PlatformStaffInviteDto {
  staff: PlatformStaffDto;
  /** One-time set-password link, valid 7 days. */
  inviteLink: string;
  /** TRUE only if an email provider is configured AND the send succeeded.
   *  False means "you must deliver this link yourself" — said plainly, because
   *  silently pretending is how the account became unreachable. */
  emailDelivered: boolean;
  /**
   * One-time temporary password — the fallback when the link cannot be used.
   *
   * A link is long and gets mangled by chat clients, and it is useless if
   * PUBLIC_WEB_URL is misconfigured. A short password can be read down a phone.
   * It grants a session and NOTHING else: `passwordChangedAt` is null, so login
   * returns `passwordExpired` and the web holds the user on the change-password
   * screen until they set their own.
   *
   * Expires with the link (7 days). The school-admin flow's equivalent does not,
   * which leaves a working credential valid for ever in whatever chat it was
   * pasted into — worse here, since platform staff carry cross-tenant reach.
   */
  tempPassword: string;
}

// --- School directory (operator) ---------------------------------------------

/** A named person + reachable contact details, as listed in the directory
 *  (the school's own staff accounts — never students). */
export interface SchoolContactDto {
  name: string;
  email: string;
  phone: string | null;
}

/** One school in the operator's search/filter directory. Contact people are the
 *  FIRST school_admin / principal accounts (the profile lists all of them). */
export interface SchoolDirectoryRowDto {
  id: string;
  name: string;
  slug: string;
  /** School status (ACTIVE | DISABLED — DISABLED blocks every member login). */
  status: string;
  ownerName: string | null;
  ownerPhone: string | null;
  address: string | null;
  admin: SchoolContactDto | null;
  principal: SchoolContactDto | null;
  /** Date the school was provisioned onto the platform. */
  onboardedAt: Date;
  /** Purchased plan + billing status (ACTIVE | PAST_DUE | CANCELED). */
  plan: string;
  subscriptionStatus: string;
  /** When the current paid/trial period ends (dunning flips PAST_DUE after). */
  currentPeriodEnd: Date | null;
  /** Most recent PAID platform-subscription payment (null = never paid). */
  lastPaymentAt: Date | null;
  /** Outstanding metered seat arrears — usage above the billed seat count,
   *  collected at next checkout/renewal. In {@link outstandingCurrency}, which is
   *  the currency the school is BILLED in, not the platform's. */
  outstandingMinor: number;
  /** The currency `outstandingMinor` is in. The operator console rendered it
   *  with no currency at all, so `money()` fell back to the platform's naira and
   *  a school billed in USD had its arrears shown under a naira sign. */
  outstandingCurrency: string;
  /** Pupils holding the student ROLE — the same definition as the billing seat
   *  count, so the two reconcile. */
  students: number;
  /** DISTINCT staff: everyone whose role is not student/parent, counted as PEOPLE
   *  rather than role assignments. A head teacher who also teaches is one person. */
  staff: number;
  /** Guardian accounts. */
  parents: number;
  /** students + staff + parents. */
  users: number;
}

export interface SchoolDirectoryPageDto {
  rows: SchoolDirectoryRowDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** A platform-subscription payment line on the school profile. */
export interface SchoolProfilePaymentDto {
  reference: string;
  kind: string;
  status: string;
  amountMinor: number;
  currency: string;
  createdAt: Date;
  paidAt: Date | null;
}

/** The complete operator-facing profile of one school. */
export interface SchoolProfileDto extends SchoolDirectoryRowDto {
  /** ALL admin/principal accounts (the row shows only the first of each). */
  admins: SchoolContactDto[];
  principals: SchoolContactDto[];
  /** DISTINCT staff — people, not role assignments (see `SchoolDirectoryRowDto`). */
  staff: number;
  /** Subscription detail. */
  billingCycle: string;
  seats: number | null;
  priceMinor: number | null;
  currency: string | null;
  graceDays: number | null;
  autoRenew: boolean;
  cardLast4: string | null;
  /** Effective (entitlement) plan + enabled module keys. */
  effectivePlan: string;
  modules: string[];
  /** Fee-collection settlement posture. */
  settlementBankName: string | null;
  settlementAccountLast4: string | null;
  admissionFormFeeMinor: number;
  /** The SCHOOL's own fee currency — what it bills FAMILIES in.
   *
   * Deliberately not the `currency` field above, which is what the school pays
   * the PLATFORM in: a Ghanaian school can be billed in USD and charge its
   * families in cedis, and this file already says so. Without it the admission
   * fee rendered in the platform's naira.
   */
  feeCurrency: string;
  /** Referrer school name when this school arrived via a referral code. */
  referredBy: string | null;
  /** Recent platform-subscription payments, newest first. */
  payments: SchoolProfilePaymentDto[];
}

// --- Operator attention queue ------------------------------------------------

/** Why a school is on the operator's attention queue. Each is a condition somebody
 *  has to DECIDE about, not merely a statistic. */
export const ATTENTION_KINDS = [
  /** Billing lapsed — modules already downgraded or about to be. */
  "PAST_DUE",
  /** Trial or paid period ends soon and the school has never paid. */
  "TRIAL_ENDING",
  /** Enrolment has grown past the billed seat count; arrears are accruing. */
  "SEAT_ARREARS",
  /** No audited activity at all recently — nobody is using the product. */
  "DORMANT",
  /** Registers have stopped being taken: the daily workflow has been abandoned. */
  "REGISTERS_STOPPED",
  /** No school_admin or principal account exists — provisioning never completed. */
  "NO_ADMIN",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** One reason a school needs a decision, with the number behind it. */
export interface AttentionSignalDto {
  kind: AttentionKind;
  /** Plain-language statement of the condition, including its figure. */
  detail: string;
  /** 1 = worth knowing, 2 = should act this week, 3 = acting late already. */
  severity: 1 | 2 | 3;
}

/** A school that needs the operator's attention, with every reason it does. */
export interface AttentionRowDto {
  schoolId: string;
  schoolName: string;
  plan: string;
  subscriptionStatus: string;
  students: number;
  staff: number;
  /** Monthly run-rate at stake if this school lapses, in the school's OWN
   *  subscription currency. It was computed from the naira price list for every
   *  school and rendered with a hard-coded naira sign, so a school billed in
   *  dollars or cedis had somebody else's money in the column the console
   *  exists to answer "what does this cost me" with. */
  mrrMinor: number;
  mrrCurrency: string;
  /** Highest severity among the signals — what the sort is on. */
  severity: 1 | 2 | 3;
  signals: AttentionSignalDto[];
}

/** The queue itself. Deliberately RANKED and BOUNDED: nobody reviews 5,000 schools
 *  by browsing, so the console's job is to name the ones that need a decision. */
export interface AttentionQueueDto {
  rows: AttentionRowDto[];
  /** Schools with at least one signal (may exceed `rows.length` — see `shown`). */
  total: number;
  /** How many rows were returned. Stated so a truncated queue never reads as a
   *  complete one — a capped list that looks complete is how things get missed. */
  shown: number;
  /** Customer schools examined. */
  scanned: number;
  /** Count of schools carrying each signal, across the WHOLE fleet — not just the
   *  page — so the headline figures are never the size of the cap. */
  byKind: Record<string, number>;
}

// --- Message-credit (SMS/WhatsApp) oversight (operator) ----------------------

/** One school's message-credit position on the operator's cross-tenant
 *  balance list. Lifetime totals are derived from the append-only ledger
 *  (purchases + sends + operator comps), never a separate running counter. */
export interface MessageCreditBalanceDto {
  schoolId: string;
  schoolName: string;
  /** SUM(deltaCredits) — usable balance right now. */
  balance: number;
  /** Lifetime credits bought (Paystack checkout). */
  totalPurchased: number;
  /** Lifetime credits consumed by SMS/WhatsApp deliveries. */
  totalSent: number;
  /** Net of every operator comp/debit adjustment (can be negative). */
  totalAdjusted: number;
}

export interface MessageCreditBalancePageDto {
  rows: MessageCreditBalanceDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** One row of a school's credit ledger, newest first (operator drill-down). */
export interface MessageCreditLedgerEntryDto {
  id: string;
  /** Positive = credited (purchase/comp), negative = debited (send/comp). */
  deltaCredits: number;
  /** PURCHASE | SEND | ADJUST. */
  reason: string;
  /** SMS | WHATSAPP for a send; null otherwise. */
  channel: string | null;
  /** Gateway reference (purchase), notificationId (send), or the operator's
   *  note (adjust) — truncated to 200 chars at write time. */
  reference: string | null;
  createdAt: Date;
}

// --- Fleet-wide games analytics (operator) -----------------------------------

/** Activity counters for one game surface. All AGGREGATE and PII-free —
 *  counts only, never names/handles (Golden Rule #5). */
export interface GamesModeStatDto {
  total: number;
  /** Currently in progress (ACTIVE status). */
  activeNow: number;
  /** Created in the last 30 days. */
  last30d: number;
}

/** Cross-tenant games adoption/engagement for the platform owner. Everything is
 *  a count; no player identity ever crosses the tenant boundary here. */
export interface GamesAnalyticsDto {
  schools: {
    total: number;
    /** Schools whose subscription entitles the GAMES module. */
    gamesEntitled: number;
    /** Schools whose own GameSettings switched games OFF despite entitlement. */
    disabledBySetting: number;
    /** Schools with at least one game of any kind created in the last 30 days. */
    activeLast30d: number;
  };
  /** Distinct player ACCOUNTS that have ever joined any game / joined recently. */
  players: { total: number; last30d: number };
  /** Number-guessing core (Dead & Wounded) by mode: DUEL, RING, RACE,
   *  LEAGUE_MATCH, KNOCKOUT_MATCH. */
  guessing: Record<string, GamesModeStatDto>;
  /** Leagues/knockouts/race tournaments. */
  competitions: { total: number; active: number; byType: Record<string, number> };
  /** The five classroom games: LIVE_QUIZ (sessions), TYPING_RACE, HANGMAN,
   *  CHESS, CHECKERS. */
  arcade: Record<string, GamesModeStatDto>;
  /** Cross-school Ultimate arena (pseudonymous by design). */
  ultimate: {
    competitions: number;
    active: number;
    participants: number;
    schoolsEnrolled: number;
    consentedStudents: number;
  };
}

/** AUDIT finding: a platform-tier role held by a user OUTSIDE the platform org.
 *  The permissions are inert (login filters `platform.*` outside the platform
 *  organisation) but the grant itself is worth surfacing and removing. */
export interface MisplacedPlatformRoleDto {
  userId: string;
  email: string;
  name: string;
  status: string;
  schoolId: string;
  schoolName: string;
  platformRoles: string[];
  grantedAt: Date;
}

// =============================================================================
// What the platform's card account can actually charge, and who needs it
// =============================================================================
// `PAYSTACK_CURRENCIES` describes what PAYSTACK supports. Whether a given
// MERCHANT ACCOUNT may charge a currency is a different question, and the
// platform was using the first as an answer to the second — so a school billing
// in GHS was routed to a rail that answers `403 Currency not supported by
// merchant`, and its parents met an unexplained refusal at checkout.
//
// This is the operator's view of the gap: what the account is enabled for,
// against what the schools on it actually bill in. Enabling a currency is a
// dashboard action nobody can take from here; knowing WHICH ones to enable, and
// who is waiting on each, is what this replaces guessing with.
export interface CurrencyCoverageDto {
  /** Currencies this Paystack account is enabled for, from its own /balance. */
  merchantCurrencies: string[];
  /** Null when the account could not be asked — reported as unknown, never as "none". */
  known: boolean;
  rows: Array<{
    currency: string;
    /** Schools billing in it. */
    schoolCount: number;
    /** A few names, so the operator knows who is affected without a second screen. */
    sample: string[];
    /** Can the account charge it today? */
    covered: boolean;
    /** Can Paystack settle it to a bank in principle? */
    railSupports: boolean;
  }>;
}

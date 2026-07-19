// Super-admin operator console response DTOs.

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
  users: number;
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
  /** Revenue from PAID platform-subscription payments (all time). */
  revenue: { paidTotalMinor: number; payments: number; last30dMinor: number };
  /** Onboarding intake pipeline (public requests) keyed by status. */
  onboardingPipeline: Record<string, number>;
  /** The most recent platform-subscription payments (newest first, capped). */
  recentPayments: PlatformRevenueEntryDto[];

  // --- decision-grade SaaS metrics (super_admin) ---
  /** Monthly recurring revenue: normalised per-seat run-rate of ACTIVE subscriptions. */
  mrr: { totalMinor: number; byPlan: Record<string, number>; arpaMinor: number; payingSchools: number };
  /** Monthly trend (chronological, last ~6 months) for growth + revenue charts. */
  growth: { month: string; schools: number; students: number; revenueMinor: number }[];
  /** Acquisition funnel: public requests → approved → provisioned schools → paying. */
  funnel: { requests: number; approved: number; provisioned: number; paying: number };
  /** Churn / delinquency signals for retention decisions. */
  risk: { pastDue: number; canceled: number; atRiskMrrMinor: number };
  /** How widely each product module is switched on (informs product investment). */
  moduleAdoption: { key: string; label: string; schools: number }[];
  /** Largest customer schools by enrolment (with their plan + MRR contribution). */
  topSchools: { name: string; students: number; plan: string; mrrMinor: number }[];
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
  /** Outstanding metered seat arrears (kobo) — usage above the billed seat
   *  count, collected at next checkout/renewal. */
  outstandingMinor: number;
  students: number;
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
  /** Referrer school name when this school arrived via a referral code. */
  referredBy: string | null;
  /** Recent platform-subscription payments, newest first. */
  payments: SchoolProfilePaymentDto[];
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

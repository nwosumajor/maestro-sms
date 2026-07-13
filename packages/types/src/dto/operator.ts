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

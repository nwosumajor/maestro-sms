// Super-admin operator console response DTOs.

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
  users: number;
  /** Subscription plan (BASIC | STANDARD | ENTERPRISE). */
  plan: string;
  /** Count of subscription-enabled modules. */
  moduleCount: number;
  /** Billing status (ACTIVE | PAST_DUE | CANCELED). */
  subscriptionStatus: string;
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
  /** Lockout deadline from failed logins, if currently locked. */
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
  /** Customer-school counts keyed by purchased plan (BASIC|STANDARD|ENTERPRISE). */
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

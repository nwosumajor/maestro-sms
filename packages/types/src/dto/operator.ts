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

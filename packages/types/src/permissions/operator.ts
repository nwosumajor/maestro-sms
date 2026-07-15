// =============================================================================
// Platform operator permissions — the console the PLATFORM OWNER runs
// =============================================================================
// Split so platform duties can be DELEGATED to staff (manager_admin) while the
// owner (super_admin) keeps absolute control. The split is by RISK OF ESCALATION,
// not by feature area — for each one, "could a holder turn this into full control?"
//
//   DELEGABLE  — operational work with no path to owner-level power.
//   OWNER-ONLY — anything that IS, or can BECOME, total control:
//     * impersonate       → literally becomes any user
//     * user.credentials  → a temp password / MFA reset IS impersonation by another
//                           route (just log in as that school_admin afterwards)
//     * pricing / subscription → changes what customers pay (revenue)
//     * tenants.status    → takes a paying school offline
//     * student.read      → minors' PII across every tenant (Golden Rule #5)
//
// EVERY permission here is cross-tenant, so EVERY one is also listed in
// NON_ELEVATABLE_PERMISSIONS (elevation.ts) — otherwise a manager_admin could
// JIT-elevate into the owner-only set and this split would be theatre.
// =============================================================================
export const OPERATOR_PERMISSIONS = {
  /** PLATFORM-OWNER IDENTITY, not a capability. Marks "this is the owner": grants
   *  cross-school directory search and the owner console framing. Deliberately NOT
   *  used to gate operator endpoints any more (they use the granular set below), so
   *  delegating duties never leaks owner identity. super_admin only. */
  PLATFORM_OPERATE: "platform.operate",

  // --- delegable: oversight + day-to-day operations -------------------------
  /** View the tenant registry, tenant names, business analytics, billing alerts. */
  PLATFORM_TENANTS_READ: "platform.tenants.read",
  /** Onboard a NEW school and add admin accounts to a school. */
  PLATFORM_TENANTS_WRITE: "platform.tenants.write",
  /** Review + decide public onboarding requests. */
  PLATFORM_ONBOARDING_REVIEW: "platform.onboarding.review",
  /** Read the cross-tenant platform audit trail (+ CSV export). */
  PLATFORM_AUDIT_READ: "platform.audit.read",
  /** Look up a school's user accounts for support triage (no credential power). */
  PLATFORM_USER_READ: "platform.user.read",
  /** Clear a login lockout — routine support; grants no access by itself. */
  PLATFORM_USER_UNLOCK: "platform.user.unlock",

  // --- owner-only: is, or becomes, absolute control --------------------------
  /** Sign in AS any user in any school. The total-control backdoor. */
  PLATFORM_IMPERSONATE: "platform.impersonate",
  /** Reset a password / reset or mandate MFA / suspend an account. A temp password
   *  is a working login for that account — impersonation by another name. */
  PLATFORM_USER_CREDENTIALS: "platform.user.credentials",
  /** Enable/disable a SCHOOL — blocks every member from logging in. */
  PLATFORM_TENANTS_STATUS: "platform.tenants.status",
  /** Change a tenant's plan/status/period — comps and overrides. Revenue. */
  PLATFORM_SUBSCRIPTION_MANAGE: "platform.subscription.manage",
  /** Set platform-wide tier pricing — what every customer pays. Revenue. */
  PLATFORM_PRICING_MANAGE: "platform.pricing.manage",
  /** Read/export a school's student records cross-tenant. Minors' PII. */
  PLATFORM_STUDENT_READ: "platform.student.read",
  /** Hire/revoke PLATFORM STAFF (manager_admin). Owner-only and never delegable:
   *  if staff could create staff, one manager could mint another and "only the
   *  owner has absolute control" quietly dissolves. The endpoint's role allow-list
   *  is exactly ["manager_admin"], so it can never mint a second super_admin. */
  PLATFORM_STAFF_MANAGE: "platform.staff.manage",
} as const;
export type OperatorPermission = (typeof OPERATOR_PERMISSIONS)[keyof typeof OPERATOR_PERMISSIONS];

/** The ONLY role POST /operator/platform-staff may ever create. Pinned here rather
 *  than passed by the caller: a caller-chosen role would make that endpoint a route
 *  to minting a second super_admin. */
export const PLATFORM_STAFF_ROLE = "manager_admin";

/** Every platform permission — all cross-tenant, therefore all non-elevatable. */
export const ALL_PLATFORM_PERMISSIONS: readonly string[] = Object.values(OPERATOR_PERMISSIONS);

/** The subset delegable to platform STAFF (manager_admin). Everything absent from
 *  this list stays with the owner. Keep in sync with seed.ts's manager_admin. */
export const DELEGABLE_PLATFORM_PERMISSIONS: readonly string[] = [
  OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ,
  OPERATOR_PERMISSIONS.PLATFORM_TENANTS_WRITE,
  OPERATOR_PERMISSIONS.PLATFORM_ONBOARDING_REVIEW,
  OPERATOR_PERMISSIONS.PLATFORM_AUDIT_READ,
  OPERATOR_PERMISSIONS.PLATFORM_USER_READ,
  OPERATOR_PERMISSIONS.PLATFORM_USER_UNLOCK,
];

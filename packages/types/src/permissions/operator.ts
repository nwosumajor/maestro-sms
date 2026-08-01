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
  /** Set a school's PER-SCHOOL grace window (days past due before the STANDARD
   *  floor kicks in). Delegable BECAUSE the API hard-caps it at GRACE_DAYS_MAX —
   *  bounded goodwill, not a comp. Unbounded plan/period changes stay owner-only
   *  (platform.subscription.manage). */
  PLATFORM_GRACE_MANAGE: "platform.grace.manage",
  /** Read + triage the cross-tenant platform-feedback inbox (complaints / feature
   *  suggestions any signed-in user can send). Delegable support work — it grants
   *  no access to school data beyond the feedback text the sender chose to write. */
  PLATFORM_FEEDBACK_REVIEW: "platform.feedback.review",

  // --- owner-only: is, or becomes, absolute control --------------------------
  /** Sign in AS any user in any school. The total-control backdoor. */
  PLATFORM_IMPERSONATE: "platform.impersonate",
  /** Reset a password / reset or mandate MFA / suspend an account. A temp password
   *  is a working login for that account — impersonation by another name. */
  PLATFORM_USER_CREDENTIALS: "platform.user.credentials",
  /** Enable/disable a SCHOOL — blocks every member from logging in. */
  PLATFORM_TENANTS_STATUS: "platform.tenants.status",
  /** Set a school's REGION — country, timezone, locale, fee currency, compliance
   *  regime. Deliberately NOT part of tenants.write, which is day-to-day
   *  provisioning a manager may hold standing. A region change flips the privacy
   *  regime, turns statutory payroll on or off for the whole school, and moves what
   *  "today" means for every register — SILENTLY. Disabling a school is louder than
   *  that (every login fails and somebody rings within the hour) and is already held
   *  to the higher tier, so this belongs there too. */
  PLATFORM_TENANTS_REGION: "platform.tenants.region",
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

/**
 * What a platform manager holds PERMANENTLY, by virtue of the role.
 *
 * Deliberately tiny: see the registry, and read your own inbox. Everything else a
 * manager does is a duty the owner LENDS them, with an expiry date — which is only
 * meaningful if the standing role does not already include it. It previously
 * included all eight delegable duties, which made time-bound delegation a no-op:
 * there was nothing left to lend.
 *
 * Keep in sync with seed.ts's manager_admin.
 */
export const PLATFORM_STAFF_BASELINE_PERMISSIONS: readonly string[] = [
  OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ,
];

/**
 * The subset that may be a manager's STANDING role permission — oversight and
 * day-to-day operations. Everything absent stays with the owner as a standing power.
 *
 * Unchanged, deliberately: `platform.tenants.status` and
 * `platform.subscription.manage` are still never granted by a ROLE, because taking
 * a paying school offline and giving away revenue are not things anyone should hold
 * by default. See LENDABLE_PLATFORM_PERMISSIONS for the separate question of what
 * the owner may lend for a fortnight.
 */
export const DELEGABLE_PLATFORM_PERMISSIONS: readonly string[] = [
  OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ,
  OPERATOR_PERMISSIONS.PLATFORM_TENANTS_WRITE,
  OPERATOR_PERMISSIONS.PLATFORM_ONBOARDING_REVIEW,
  OPERATOR_PERMISSIONS.PLATFORM_AUDIT_READ,
  OPERATOR_PERMISSIONS.PLATFORM_USER_READ,
  OPERATOR_PERMISSIONS.PLATFORM_USER_UNLOCK,
  OPERATOR_PERMISSIONS.PLATFORM_GRACE_MANAGE,
  OPERATOR_PERMISSIONS.PLATFORM_FEEDBACK_REVIEW,
];

/**
 * What the owner may LEND to a platform manager for a bounded, audited, revocable
 * window (PlatformDelegation) — a strictly different question from what a ROLE may
 * carry, and the distinction is the point.
 *
 * "Standing" and "for eleven days, with a reason, revocable in one click, and
 * logged at every use" are not the same risk. So this set is the delegable duties
 * PLUS a higher tier that must never be standing:
 *
 *   platform.tenants.status       — an outage for one school; instantly reversible
 *   platform.subscription.manage  — comp or extend; loud in the audit trail
 *
 * Still absent, at any duration: impersonation, platform.operate, plan credentials,
 * pricing, student records and hiring platform staff. Lending one of those for a
 * week is indistinguishable from giving it away, so they are not lent at all.
 */
export const LENDABLE_PLATFORM_PERMISSIONS: readonly string[] = [
  ...DELEGABLE_PLATFORM_PERMISSIONS,
  OPERATOR_PERMISSIONS.PLATFORM_TENANTS_STATUS,
  OPERATOR_PERMISSIONS.PLATFORM_SUBSCRIPTION_MANAGE,
  OPERATOR_PERMISSIONS.PLATFORM_TENANTS_REGION,
];

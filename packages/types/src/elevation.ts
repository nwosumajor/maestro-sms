// =============================================================================
// JIT elevation — non-elevatable permission denylist
// =============================================================================
// Permissions that may NEVER be obtained through Just-In-Time elevation or
// break-glass. These are platform/cross-tenant powers, role-assignment, the
// elevation-approval power itself, or maker-checker "checker" authorities whose
// entire purpose is that they come from a SEPARATE, durable identity (the JWT /
// super_admin), not a self-service temporary grant. Elevation exists for
// temporary OPERATIONAL access (e.g. a teacher briefly reading a medical record),
// never for escalating into these. Enforced both at request time
// (SecurityService) and at use time (PermissionGuard) — defence in depth, so even
// a legacy or tampered ACTIVE grant for one of these is never honoured.
// =============================================================================
import { ALL_PLATFORM_PERMISSIONS } from "./permissions/operator";

export const NON_ELEVATABLE_PERMISSIONS: ReadonlySet<string> = new Set<string>([
  // EVERY platform.* permission — the whole cross-tenant operator surface. Spread
  // from the source of truth so a NEW platform permission is non-elevatable the
  // moment it is defined: forgetting one here would hand a manager_admin a
  // self-service path to owner-only powers (impersonate, pricing, credentials).
  ...ALL_PLATFORM_PERMISSIONS,
  "billing.manage", // self-serve subscription / spend
  "billing.dunning.run", // privileged cross-tenant sweep
  "rbac.manage", // assign roles → escalate others
  "security.elevation.approve", // approve elevations → escalate
  "fee.approve", // maker-checker on money
  "hr.salary.approve", // maker-checker on salary
  "game.ultimate.admin", // super_admin cross-school arena
  "scholarship.admin", // super_admin cross-tenant program review + award
]);

/** May this permission be granted via JIT elevation / break-glass? */
export function isElevatable(permission: string): boolean {
  return !NON_ELEVATABLE_PERMISSIONS.has(permission);
}

// =============================================================================
// Owner → platform-manager DELEGATION (a different question from elevation)
// =============================================================================
// `isElevatable` answers "may someone REQUEST this for themselves and have a peer
// approve it" — no platform permission ever may, or the owner/staff split would be
// theatre.
//
// This answers a different question: "may the platform OWNER lend this duty to a
// manager for a while". Some may, because the direction is reversed. Nobody gains
// anything the granting identity did not already hold, and the grantor is the sole
// holder of the non-delegable authority — so there is no escalation path, only a
// loan with an expiry date.
//
// The lendable set is LENDABLE_PLATFORM_PERMISSIONS: the duties a role may carry,
// PLUS a higher tier that must never be standing — disabling a school and comping a
// subscription. What is NOT lendable at any duration: impersonation, pricing, plan
// credentials, student PII, hiring platform staff, and platform.operate itself —
// the owner keeps those permanently, because lending one of them for a week is
// indistinguishable from giving it away.
// =============================================================================
import { LENDABLE_PLATFORM_PERMISSIONS } from "./permissions/operator";

/** Longest a duty may be lent for. Beyond this it is not a delegation, it is a
 *  role change that nobody remembered to review. */
export const MAX_DELEGATION_DAYS = 90;
/** Sensible default when the owner does not pick one — a fortnight of cover. */
export const DEFAULT_DELEGATION_DAYS = 14;

/** May the platform owner lend this permission to a platform manager? */
export function isDelegatablePlatformPermission(permission: string): boolean {
  return LENDABLE_PLATFORM_PERMISSIONS.includes(permission);
}

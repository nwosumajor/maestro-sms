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
export const NON_ELEVATABLE_PERMISSIONS: ReadonlySet<string> = new Set<string>([
  "platform.operate", // cross-tenant operator console + impersonation
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

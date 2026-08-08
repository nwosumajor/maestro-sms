import type { Permission } from "@sms/types";

/**
 * Permission check whose `perm` argument is typed against the canonical
 * `Permission` union from @sms/types. The string literals stay readable at the
 * call site, but a typo or a permission that has been renamed away in the source
 * of truth now fails the type-check instead of silently mis-gating the UI.
 */
export function hasPermission(permissions: string[], perm: Permission): boolean {
  return permissions.includes(perm);
}

/**
 * Who the Report Center is for. It is a STAFF hub: every report it lists is a
 * management view of the whole school. Defined here because BOTH the AppShell
 * nav entry and the /reports page must agree — when they drifted, the nav hid
 * the link while the page still rendered for a parent who reached it by URL,
 * which is the same disagreement in the other direction.
 *
 * Deliberately NOT `attendance.read` (its previous gate), which every parent,
 * student, teacher, warden and driver holds. A family reader's own figures live
 * on /analytics, which is in their nav already and states its own scope.
 */
export const REPORT_CENTER_PERMISSIONS: Permission[] = [
  "fee.manage",
  "hr.read",
  "security.audit.read",
  "library.manage",
  "form.manage",
];

/** True when the caller has at least one report the hub can actually show them. */
export function canSeeReportCenter(permissions: string[]): boolean {
  return REPORT_CENTER_PERMISSIONS.some((p) => permissions.includes(p));
}

export type { Permission };

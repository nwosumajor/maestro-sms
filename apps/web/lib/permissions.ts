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

export type { Permission };

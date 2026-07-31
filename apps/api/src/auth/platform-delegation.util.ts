// =============================================================================
// Is this platform duty currently on loan to this manager?
// =============================================================================
// A plain function rather than an injectable, deliberately: the PermissionGuard is
// global and the delegation service lives in OperatorModule, so wiring one into the
// other by DI would build a module cycle around the guard — the last place that
// should be fragile. Same pattern as operator-people.ts.
//
// It lives here, next to the guard, because BOTH callers must apply the same rule
// and the guard is the one that must never be bypassed.
// =============================================================================

import { isDelegatablePlatformPermission } from "@sms/types";
import type { TenantTx } from "../integrity/integrity.foundation";

/**
 * True when the platform owner has lent `permission` to `userId` and the loan is
 * still live — not revoked, not expired.
 *
 * Re-checks the lendable set rather than trusting the row. A delegation written
 * before that set was tightened, or inserted by any other route, still cannot carry
 * impersonation, pricing, credentials or student PII. Mirrors how `isElevatable` is
 * enforced at both request time and use time in the elevation path.
 */
export async function hasLiveDelegation(
  tx: TenantTx,
  userId: string,
  permission: string,
): Promise<boolean> {
  if (!isDelegatablePlatformPermission(permission)) return false;
  const row = await tx.platformDelegation.findFirst({
    where: { userId, permission, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return !!row;
}

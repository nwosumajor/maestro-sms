import { isElevatable } from "@sms/types";
import type { TenantTx } from "../integrity/integrity.foundation";

/**
 * Every ELEVATABLE permission a user currently holds by an ACTIVE, unexpired
 * privilege grant — the one definition of "what an elevation gives you".
 *
 * It lives here because two callers need the same answer and must not drift:
 * the PermissionGuard, which merges it into `principal.permissions` so the API
 * honours a grant; and the login/refresh claims, so the BROWSER knows about one
 * too. They disagreed before this existed. A teacher granted `hr.read` could
 * read /hr/employees through the API and was redirected off the /hr page, so
 * the platform's own answer to an absent colleague was reachable only by
 * somebody willing to call the API by hand.
 *
 * SECURITY: platform/cross-tenant and maker-checker permissions are NEVER
 * honoured from a grant, even if an ACTIVE row exists (legacy or tampered) —
 * `isElevatable` is applied here so neither caller can forget it.
 */
export async function activeGrantPermissions(tx: TenantTx, userId: string): Promise<string[]> {
  const grants = await tx.privilegeGrant.findMany({
    where: { userId, status: "ACTIVE", expiresAt: { gt: new Date() } },
    select: { permission: true },
  });
  // Array.isArray rather than a cast: a tenant runner that returns nothing must
  // degrade to "no grants", not crash the gate for every request. A `try` does
  // not catch a wrong SHAPE.
  if (!Array.isArray(grants)) return [];
  return (grants as Array<{ permission: string }>)
    .map((g) => g.permission)
    .filter((perm) => typeof perm === "string" && isElevatable(perm));
}

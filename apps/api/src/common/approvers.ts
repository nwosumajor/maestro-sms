// =============================================================================
// Who, in THIS school, can approve a thing — and whether anybody can
// =============================================================================
// Every maker-checker control here rests on the same sentence: a DIFFERENT
// person holding a named permission must decide. That makes "who holds it" a
// question the platform asks constantly, and I had written it three separate
// times — in the workflow engine, in the notification helper, and again here —
// before putting it in one place.
//
// The second function is the one with teeth. A two-person rule in a school with
// ONE holder of the permission is not a control, it is a dead end: the request
// can be raised and can never be decided, by anyone, ever. Nothing detected
// that. The request was created, it sat, and the only symptom was silence —
// made louder by the notices added in 2c6151b, which correctly send to nobody.
//
// It is not a hypothetical shape. A school that never appointed a school_admin
// has exactly one fee.approve holder in its principal; a school that
// deactivates one of two is back to one without anybody deciding to.
//
// TENANT-SCOPED, unlike RolePermissionsService, which answers the global
// question "what does this ROLE grant" and holds no tenant context. This one
// asks which USERS in the caller's own school hold it, so it takes a tx and is
// bounded by RLS.
// =============================================================================

import type { TenantTx } from "../integrity/integrity.foundation";

/** Every user in the tenant whose roles grant `permission`. ONE query. */
export async function holdersOf(tx: TenantTx, permission: string): Promise<string[]> {
  const rows = (await tx.userRole.findMany({
    where: { role: { permissions: { some: { permission: { key: permission } } } } },
    select: { userId: true },
    distinct: ["userId"],
  })) as Array<{ userId: string }>;
  return [...new Set(rows.map((r) => r.userId))];
}

/**
 * Could anybody other than `userId` decide this?
 *
 * Asked BEFORE a maker-checker request is created, so a school is told it has no
 * second approver at the moment it tries — rather than discovering it when the
 * request has been sitting for a week and nobody can explain why.
 */
export async function hasSecondApprover(
  tx: TenantTx,
  permission: string,
  userId: string,
): Promise<boolean> {
  return (await holdersOf(tx, permission)).some((id) => id !== userId);
}

/**
 * The sentence a school is shown when there is nobody else.
 *
 * It says what to DO. "Forbidden" or "no approver found" leaves an administrator
 * guessing at a fix that is one role assignment away, and the fix is not
 * something they can be expected to infer from the permission string.
 */
export function noSecondApproverMessage(what: string, permission: string): string {
  return (
    `${what} has to be approved by a different person, and you are currently the only member of staff who can approve it. ` +
    `Ask an administrator to give "${permission}" to a second member of staff, then try again.`
  );
}

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

/**
 * Every user in the tenant who can exercise `permission`. ONE query.
 *
 * ACTIVE only, and that word is doing the work. Exiting a member of staff sets
 * `User.status = EXITED` and deliberately LEAVES their `user_role` rows alone —
 * the row is employment history, and auth refuses the login instead. So the
 * plain role query answered "who was ever given this", and every caller here is
 * asking "who could decide this now". A school whose only head teacher resigned
 * on Friday was still told, on Monday, that its approval chain was staffed.
 *
 * That is not a cosmetic difference. It is the precise case the dead-end guard
 * exists to catch, and counting a departed approver walks straight past it: the
 * request is accepted, sits at a stage its one holder can no longer reach, and
 * says "pending" for ever.
 *
 * DELIBERATELY NOT counting a temporary elevation grant. A grant CAN carry
 * `workflow.review.*` — it is elevatable — so this under-reports for the hours
 * one is live. But the recertification report asks this same question to say
 * whether a two-person rule is STAFFED, and a control held up by a grant that
 * expires on Thursday is exactly the thin control it is trying to name.
 */
export async function holdersOf(tx: TenantTx, permission: string): Promise<string[]> {
  const rows = (await tx.userRole.findMany({
    where: {
      user: { status: "ACTIVE" },
      role: { permissions: { some: { permission: { key: permission } } } },
    },
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
/**
 * The sentence for a stage with NOBODY in it — which is a different fact from
 * "you are the only one", and saying the wrong one sends an administrator
 * looking for a person who does not exist.
 */
export function noApproverAtAllMessage(what: string, permission: string): string {
  return (
    `${what} has to be approved, and nobody at this school currently can. ` +
    `Ask an administrator to give "${permission}" to a member of staff, then try again.`
  );
}

export function noSecondApproverMessage(what: string, permission: string): string {
  return (
    `${what} has to be approved by a different person, and you are currently the only member of staff who can approve it. ` +
    `Ask an administrator to give "${permission}" to a second member of staff, then try again.`
  );
}

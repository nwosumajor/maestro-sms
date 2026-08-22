// =============================================================================
// Two people cannot roster the same person into two places at once
// =============================================================================
// `assertNoInvigilatorClash` and the cover service's double-booking check both
// READ what somebody is already down for, decide in Node, and then INSERT.
// Between the read and the insert there is nothing, so two requests that arrive
// together both see a clear diary and both succeed. Proved live, one member of
// staff and two sittings in the same 09:00–11:00 window:
//
//   sequential   201 then 409   (the check works)
//   concurrent   201 and 201    → rostered in TWO halls at 09:00
//
// The failure is the exact one the check exists to prevent, and the exam
// service says so in its own comment: "the failure surfaces on exam morning
// with one of the two halls simply unattended".
//
// WHY A LOCK AND NOT A CONSTRAINT. The other races in this codebase were closed
// with a unique key or an atomic claim — the library decrements
// `availableCopies` with a predicate, hostel allocation row-locks the room. That
// works when the thing being claimed is one row. A clash is not: it is "does any
// row overlap this time window", spanning two tables for cover (the assignment
// and the timetable entry it hangs off) and an interval comparison for exams.
// No unique index expresses it.
//
// So the transaction takes a lock on THE PERSON. Two requests rostering the same
// individual serialise and the second reads the first's committed row and
// refuses; requests about different people never touch each other, which matters
// because rostering a whole exam hall is a burst of them.
//
// TRANSACTION-SCOPED (`_xact_`): released at commit or rollback, with no unlock
// call to forget and nothing left held by a request that threw.
// =============================================================================

import type { TenantTx } from "../integrity/integrity.foundation";

/**
 * Serialise everything this transaction does about one person, within one school.
 *
 * The key is hashed to the 32 bits Postgres advisory locks take. A collision
 * makes two unrelated pairs wait for each other for the rest of a transaction —
 * harmless, and never incorrect; the alternative of a per-school lock would
 * serialise a whole roster.
 *
 * SCHOOL-SCOPED because the lock namespace is cluster-wide: without the tenant
 * in the key, one school's rostering would block another's.
 */
export async function lockPerson(tx: TenantTx, schoolId: string, personId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${schoolId}:${personId}`}))`;
}

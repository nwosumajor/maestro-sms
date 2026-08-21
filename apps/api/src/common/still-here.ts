// =============================================================================
// Handing work to somebody who has left
// =============================================================================
// Exiting a member of staff sets `User.status = EXITED` and DELIBERATELY leaves
// their roles and their record in place (see hr/staff-access.ts): auth's ACTIVE
// allowlist refuses the login, the row survives for the audit, and reinstating
// someone who returns is one field.
//
// Nothing on the OTHER side asked. `GET /users?kind=staff` — the picker behind
// every assignment screen — had no status filter, so a teacher who left last
// term went on being offered by name for months. And the services took them:
//
//   cover reliever      checks self-cover and double-booking, not employment
//   exam invigilator    refuses a STUDENT by role, not somebody who has gone
//   class teacher       "Teacher not found" only if the row is missing
//   subject teacher     same
//   task assignee       "not in this school" only if the row is missing
//   hostel warden       assertUserInSchool: exists, therefore fine
//   transport driver    same
//   discipline assignee same
//
// The duty roster is the one that got it right — it resolves through
// `employee.status = "ACTIVE"` — which is what made the rest visible.
//
// Every one of these is FUTURE WORK. The failure is not a broken screen: it is
// Tuesday period 3 with a reliever who does not work here, an exam hall with a
// roster and nobody in it, a safeguarding complaint assigned to an empty desk.
// Each also fires a notification into an inbox its owner can no longer open, so
// the assigner's screen says "notified" and nobody was.
//
// DELIBERATELY NARROW. This is for assigning work to be done. Reading a
// departed person's NAME onto a record they were part of is right and stays
// untouched — a payslip, an old audit entry, last year's report card, the
// history of a case. A leaver disappearing from their own past is a different
// and worse bug. The rule is future work, not past record.
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { TenantTx } from "../integrity/integrity.foundation";

/** Users who may be handed work: in this school (RLS) and not departed. */
export const STILL_HERE = { status: "ACTIVE" } as const;

/**
 * Resolve somebody who is being given work, or refuse with a usable sentence.
 *
 * Two different refusals, because they send the assigner to two different
 * places. A missing row is 404 — the id is wrong, or belongs to another school,
 * and saying which would disclose that a foreign id exists. Somebody who has
 * LEFT is a 400 that names them, because the assigner picked a real colleague
 * off a real list and needs to know why the answer is no.
 *
 * `what` is the noun the caller uses on screen ("reliever", "invigilator"), so
 * the message reads as the school's own language rather than the schema's.
 */
export async function assertStillHere(
  tx: TenantTx,
  userId: string,
  what: string,
): Promise<{ id: string; name: string }> {
  const u = (await tx.user.findFirst({
    where: { id: userId },
    select: { id: true, name: true, status: true },
  })) as { id: string; name: string; status: string } | null;
  if (!u) throw new NotFoundException(`${what} not found`);
  // Fails CLOSED on anything that is not ACTIVE, including a row with no status
  // at all — every `user` row has the column, so a row without one is a fixture
  // pretending to be something the database cannot produce.
  if (u.status !== "ACTIVE") {
    throw new BadRequestException(
      `${u.name} has left the school. Pick somebody who is still here.`,
    );
  }
  return { id: u.id, name: u.name };
}

/**
 * The same question for a batch — one query, not one per person.
 *
 * Returns the names of anyone who has left, so a caller assigning twelve people
 * can name all of them at once rather than refusing twelve times.
 */
export async function whoHasLeft(tx: TenantTx, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = (await tx.user.findMany({
    where: { id: { in: userIds }, NOT: { status: "ACTIVE" } },
    select: { name: true },
  })) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

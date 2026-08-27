// =============================================================================
// Ending a departed staff member's access
// =============================================================================
// WHAT THIS FIXES. Approving a staff exit closed the EMPLOYMENT record — status
// EXITED, end date, final settlement, loans recovered — and stopped there. The
// person's ACCOUNT stayed ACTIVE. A teacher who had left could still sign in the
// next morning and still held every permission they left with: grades,
// attendance, student profiles, medical records, messaging, documents.
//
// The offboarding checklist has an item labelled "Revoke system access". It is a
// TICKBOX. Ticking it changes nothing. So the platform looked like it had handled
// this — an HR clerk ticks the box, believing the account is closed — while doing
// nothing at all. A missing feature is safer than one that appears to be there.
//
// This mirrors the pupil exit, which sets `User.status = EXITED` and lets auth's
// existing ACTIVE allowlist do the work, for both login and the session refresh
// that kills a live session. Two facts, kept apart:
//
//   Employee.status  — the employment relationship
//   User.status      — whether this person may use the platform
//
// ROLES ARE DELIBERATELY LEFT IN PLACE. Status is what auth checks, so keeping
// the role rows costs nothing and buys two things: reinstating someone who
// returns is one field rather than a reconstruction from memory, and the record
// of what they held survives for an audit. The same choice the pupil exit makes.
// =============================================================================

import type { TenantTx } from "../integrity/integrity.foundation";

/**
 * Has the last working day arrived?
 *
 * A staff exit is normally approved BEFORE the person leaves — someone serving a
 * month's notice still has to teach their classes — so this is the difference
 * between ending access correctly and locking a teacher out of their own
 * timetable for their whole notice period. Compared by DAY, not instant: an exit
 * dated today ends access today, not at midnight tonight.
 */
export function endsOnOrBefore(lastWorkingDay: Date | string, todayAtTheSchool: Date): boolean {
  // BOTH SIDES ARE CALENDAR DAYS, and the second must be the SCHOOL's.
  //
  // This compared a `@db.Date` last working day against the SERVER's UTC day,
  // on the one decision that ends a person's access. West of UTC that day rolls
  // over while the school is still open: in Toronto the UTC date advances at
  // 20:00 local, so a leaver was locked out during the final hours of their own
  // last working day — writing their handover notes. East of UTC it is correct
  // by accident, which is why nothing ever showed it.
  //
  // The caller resolves the school's day (`region.todayInTx` / `forSchool`),
  // exactly as the register, the gate scan, the term lock and the staff
  // clock-in already do. The parameter is NAMED for it so a future caller
  // passing a bare `new Date()` reads wrong at the call site.
  const d = new Date(lastWorkingDay);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const today = Date.UTC(
    todayAtTheSchool.getUTCFullYear(),
    todayAtTheSchool.getUTCMonth(),
    todayAtTheSchool.getUTCDate(),
  );
  return day <= today;
}


/**
 * End a departed staff member's access, in the caller's transaction.
 *
 * Guarded on ACTIVE so a replayed sweep cannot overwrite a status somebody has
 * since changed — the same guard the pupil exit uses. Returns whether it
 * actually changed anything, so a sweep can report real numbers rather than
 * counting rows it looked at.
 */
export async function revokeStaffAccessInTx(tx: TenantTx, userId: string): Promise<boolean> {
  const changed = await tx.user.updateMany({
    where: { id: userId, status: "ACTIVE" },
    data: { status: "EXITED", exitedAt: new Date() },
  });
  return changed.count > 0;
}

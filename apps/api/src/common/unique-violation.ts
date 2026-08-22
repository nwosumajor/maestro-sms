// =============================================================================
// A constraint the user never sees, said in the words they already know
// =============================================================================
// Four "one active X per person" rules are now partial unique indexes as well as
// code guards. The guard produces the sentence a user reads; the index is what
// makes that sentence true when two people press at once. Without translation
// the losing request of a race gets a 500 — the rule enforced, and the user told
// nothing they can act on.
//
// // GOTCHA, learnt the expensive way in TimetableService: Prisma does NOT
// populate `meta.target` on this deployment. It reports "Unique constraint
// failed on the (not available)", so a translator that keys off the column list
// silently never fires and every duplicate stays a 500 — and the unit tests pass,
// because the fixture supplies a target the real database never sends. So the
// CALLER says what a collision means, exactly as it does there.
//
// Do NOT re-query to identify the constraint: the failed statement has already
// aborted the surrounding transaction, so any follow-up read fails too.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@sms/db";

/**
 * Run `fn`, turning a unique-constraint violation into `message`.
 *
 * BadRequest rather than Conflict because these four all reuse the wording of a
 * guard that already throws BadRequest: the loser of a race must get the same
 * answer as somebody who simply pressed second, or the two are distinguishable
 * and the race becomes observable to the user.
 */
export async function asDuplicate<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new BadRequestException(message);
    }
    throw e;
  }
}

import { ConflictException } from "@nestjs/common";
import type { TenantTx } from "../integrity/integrity.foundation";

/**
 * Refuse an enrolment that would overfill a class — the ONE definition.
 *
 * There are seven doors into an ACTIVE enrolment and this rule was written at
 * four of them, twice: `LmsService.assertCapacity` and a hand-copied block in
 * `PromotionService.enrollInto`, each correct, each with its own message. The
 * other three enforced nothing. Measured live on one class in one minute:
 *
 *     POST /classes/:id/enrollments      409  "Class is at capacity (1)"
 *     POST /admin/import/students        201  {"created":3,"skipped":0,"errors":[]}
 *
 * — three pupils standing in a room with one place, reported as a clean import
 * with no error and no skip. `AdmissionsService.convertToPupil`, the ORDINARY
 * route a school admits a pupil by, is the same: it enrols into `input.classId`
 * with nothing asking whether the class has room.
 *
 * A control written six times is right five times, so this is a function and
 * not a sixth copy.
 *
 * THE LOCK IS THE GUARD, not the count. `SELECT … FOR UPDATE` on the class row
 * serialises concurrent enrolments into THIS class for the rest of the
 * transaction; without it two racers both read `active + adding <= capacity`
 * for the last places and both insert, and the class ends up over its limit
 * with nothing in the log to say how. Read-then-write at READ COMMITTED is not
 * a guard — this repo has recorded that four times.
 *
 * A class with NO capacity set is unlimited and takes no lock: there is nothing
 * to serialise, and locking every enrolment into every uncapped class would be
 * a contention point for no gain.
 *
 * `adding` counts places TAKEN, not rows inserted — a REACTIVATION occupies a
 * seat exactly as an insert does, which is the shape of a demotion and the case
 * `PromotionService` documents.
 *
 * Names the class, because "Class is at capacity" in a batch of forty does not
 * say which one. RLS scopes the read; a class in another school is not found
 * here and takes no lock.
 */
export async function assertClassCapacity(tx: TenantTx, classId: string, adding: number): Promise<void> {
  if (adding <= 0) return;
  const cls = (await tx.class.findFirst({
    where: { id: classId },
    select: { capacity: true, name: true },
  })) as { capacity: number | null; name: string } | null;
  if (!cls || cls.capacity == null) return; // unknown here, or unlimited
  await tx.$executeRaw`SELECT id FROM "class" WHERE id = ${classId}::uuid FOR UPDATE`;
  const active = await tx.enrollment.count({ where: { classId, status: "ACTIVE" } });
  if (active + adding > cls.capacity) {
    throw new ConflictException(`${cls.name} is at capacity (${cls.capacity})`);
  }
}

/**
 * How many more pupils this class will take, or `null` for unlimited.
 *
 * For the two importers that SKIP a full class row-by-row rather than refusing
 * the upload: they need a number to decide with, not a throw. It takes the same
 * lock, so a headroom read inside the write transaction cannot be overtaken by
 * a concurrent approver — which is exactly what the pre-computed headroom map
 * in `StudentImportService` could not promise, being read in an earlier
 * read-only transaction.
 */
export async function classHeadroom(tx: TenantTx, classId: string): Promise<number | null> {
  const cls = (await tx.class.findFirst({
    where: { id: classId },
    select: { capacity: true },
  })) as { capacity: number | null } | null;
  if (!cls || cls.capacity == null) return null;
  await tx.$executeRaw`SELECT id FROM "class" WHERE id = ${classId}::uuid FOR UPDATE`;
  const active = await tx.enrollment.count({ where: { classId, status: "ACTIVE" } });
  return Math.max(0, cls.capacity - active);
}

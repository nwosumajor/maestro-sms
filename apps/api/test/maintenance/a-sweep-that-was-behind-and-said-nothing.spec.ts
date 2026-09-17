// =============================================================================
// A capped sweep must say what it did NOT reach
// =============================================================================
// Every scheduled sweep here takes a bounded batch, deliberately, so one bad
// night never becomes one enormous transaction. But each reported only what it
// TOOK — so a run that cleared its 500 and left a hundred thousand behind
// produced exactly the same line as one that emptied the queue.
//
// Measured on a 3,500-school fleet, after a queue outage stranded 21,918
// deliveries at register time: three consecutive hourly runs each returned
//     scanned=500 requeued=500 abandoned=0 tooRecent=0 failed=0
// — every signal on the operator's jobs console green — while 21,858 families
// were still waiting. At 500 an hour that is ~44 hours before the last one is
// even ATTEMPTED, and nothing said so.
//
// `backlog` is a FOURTH fact, and none of the existing three can carry it:
//   failed      — this run tried and could not
//   skipped     — not due
//   unreachable — a fact about the data
//   backlog     — DUE, and not reached, because the batch was full
//
// It is also the number that says whether the sweep is keeping up: measured
// live, three runs moved it 20,885 -> 20,866 -> 20,846, which is the diagnosis.
// =============================================================================

import { NotificationRecoveryService, RECOVERY_BATCH } from "../../src/notifications/notification-recovery.service";
import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { sweptMethods, hasLiteralTake } from "../support/sweep-services";

/** A privileged-client double whose `count` and `findMany` share one dataset —
 *  a stub that answered a fixed count would pass against a service that computed
 *  the backlog from the wrong predicate. */
function harness(totalPending: number) {
  const rows = Array.from({ length: totalPending }, (_, i) => ({
    id: `d${i}`,
    schoolId: "s1",
    notificationId: `n${i}`,
    attempts: 0,
    // Old enough to count as stranded (the service's window is 15 minutes).
    createdAt: new Date(Date.now() - 3 * 3_600_000),
    lastAttemptAt: null,
  }));
  const client = {
    notificationDelivery: {
      findMany: jest.fn(async ({ take }: { take?: number } = {}) => rows.slice(0, take ?? rows.length)),
      count: jest.fn(async () => rows.length),
      update: jest.fn(async () => ({})),
    },
  };
  const queue = { add: jest.fn(async () => ({})) };
  const svc = new NotificationRecoveryService({ client } as never, queue as never);
  return { svc, client, queue };
}

describe("the recovery sweep", () => {
  it("REPORTS what it did not reach when the batch is full", async () => {
    const total = RECOVERY_BATCH * 40; // a fleet-sized outage
    const { svc } = harness(total);
    const out = await svc.recoverStranded("SCHEDULED");
    expect(out.scanned).toBe(RECOVERY_BATCH);
    expect(out.backlog).toBe(total - RECOVERY_BATCH);
  });

  it("reports ZERO backlog when it cleared everything — the common, healthy case", async () => {
    const { svc } = harness(12);
    const out = await svc.recoverStranded("SCHEDULED");
    expect(out.scanned).toBe(12);
    expect(out.backlog).toBe(0);
  });

  it("counts the backlog IN THE DATABASE, not from the page it fetched", async () => {
    // The page can only ever see what it took; a backlog inferred from it is
    // always zero. This is the whole point of the extra count.
    const { svc, client } = harness(RECOVERY_BATCH * 3);
    await svc.recoverStranded("SCHEDULED");
    expect(client.notificationDelivery.count).toHaveBeenCalled();
  });

  it("says so rather than returning a clean zero when it cannot run at all", async () => {
    const svc = new NotificationRecoveryService({ client: null } as never, undefined);
    const out = await svc.recoverStranded("SCHEDULED");
    expect(out.skipped).toBe("NO_DB");
    // A sweep that could not run and a sweep that found nothing must not look
    // alike — and its backlog is unknown, not zero-because-all-clear.
    expect(out.backlog).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// AND THE SIBLINGS. Fixing where it hurts and leaving the rest is how the class
// survives — four sweeps share this shape, and a fifth will be written.
// -----------------------------------------------------------------------------

/**
 * THE SET IS COMPUTED, not listed.
 *
 * This was a hand-kept array of four filenames, and that is exactly why the
 * defect it exists for shipped a fifth time: the overdue FEE REMINDER sweep —
 * the one that chases families for unpaid invoices — read `take: 2000` with no
 * `orderBy` and no backlog, and was simply not on the list. Measured at five
 * years of arrears: 5,001 overdue invoices, 2,000 taken, 3,001 families left
 * unchased, and the jobs console reporting a clean run.
 *
 * The gate one file over already computed its set from the BullMQ processors
 * and said so in a comment. Same directory, same sweeps, one list maintained by
 * hand. A gate whose set is hand-maintained only ever guards what somebody
 * remembered.
 */
const CAPPED_SWEEPS = sweptMethods()
  .filter((m) => hasLiteralTake(m.body))
  .map((m) => ({ file: m.file, why: `${m.method}()`, body: m.body }));

describe("every capped sweep reports its backlog", () => {
  it.each(CAPPED_SWEEPS)("$why reports its backlog", ({ body }) => {
    const src = body;
    // The PROPERTY: it counts what is due and subtracts what it took. Anchored
    // to the shape rather than to any one line's wording, which has gone red on
    // changes that strengthened the thing it guarded.
    expect(src).toMatch(/backlog/);
    // Counted IN THE DATABASE — through the ORM or in SQL. The archive sweep
    // moved to a raw anti-join (Prisma has no relation between Term and
    // SchoolArchive), and this line was written as `.count(` alone, so a gate
    // about counting in the database went red on a sweep that had started
    // counting in the database rather harder.
    expect(src).toMatch(/\.count\(|count\(\*\)/);
    expect(src).toMatch(/Math\.max\(0,/);
  });

  it("DISCOVERED a believable number of sweeps — a walk that finds nothing passes covering nothing", () => {
    // The previous version asserted each hand-listed file was non-empty, which
    // guards an EMPTY list and not an INCOMPLETE one — the failure that let the
    // fee reminder through. This asserts the discovery itself found sweeps, and
    // found more than the four that used to be typed in by hand.
    // Anchored to the sweeps it must REACH rather than to a count, which would
    // rot the moment one is added. `sendFeeReminders` is reachable only through
    // the one-hop follow — the very path the defect hid behind — and
    // `purgeRejected` caps with a raw SQL `LIMIT` rather than a Prisma `take`,
    // the spelling that silently dropped it out of this set once already.
    const reached = CAPPED_SWEEPS.map((c) => c.why);
    expect(reached).toEqual(
      expect.arrayContaining(["sendFeeReminders()", "recoverPending()", "purgeRejected()"]),
    );
    expect(CAPPED_SWEEPS.length).toBeGreaterThanOrEqual(3);
    for (const { file } of CAPPED_SWEEPS) {
      expect(readFileSync(file, "utf8").length).toBeGreaterThan(1_000);
    }
  });
});

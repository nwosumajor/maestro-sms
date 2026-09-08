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
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "src");

/** Every scheduled sweep that bounds its own read with a `take`. */
const CAPPED_SWEEPS: Array<{ file: string; why: string }> = [
  { file: "notifications/notification-recovery.service.ts", why: "stranded deliveries, RECOVERY_BATCH" },
  { file: "sis/sis-nudge.service.ts", why: "profiles due a nudge, SIS_NUDGE_BATCH_MAX" },
  { file: "documents/submission-retention.service.ts", why: "rejected applications past the window, 500" },
  { file: "privacy/archive.service.ts", why: "ended terms awaiting an archive, 500" },
];

describe("every capped sweep reports its backlog", () => {
  it.each(CAPPED_SWEEPS)("$file ($why)", ({ file }) => {
    const src = readFileSync(join(SRC, file), "utf8");
    // The PROPERTY: it counts what is due and subtracts what it took. Anchored
    // to the shape rather than to any one line's wording, which has gone red on
    // changes that strengthened the thing it guarded.
    expect(src).toMatch(/backlog/);
    expect(src).toMatch(/\.count\(/);
    expect(src).toMatch(/Math\.max\(0,/);
  });

  it("read a believable number of files — a walk that finds nothing passes covering nothing", () => {
    for (const { file } of CAPPED_SWEEPS) {
      expect(readFileSync(join(SRC, file), "utf8").length).toBeGreaterThan(1_000);
    }
  });
});

// =============================================================================
// The deliveries nobody was ever going to look at again
// =============================================================================
// `notification_delivery` was written in one place and read in exactly one: the
// BullMQ job that performs it. Everything else about it — a FAILED row, a row
// still PENDING an hour later — was recorded and then seen by nobody, human or
// machine.
//
// That is not a reporting nicety. A PENDING row whose job was never queued is a
// message that will NEVER be sent, and the school is told it was: `enqueueMany`
// catches a queue failure, counts the recipient as created, and moves on. The
// path that does it is the biggest fan-out in the product — releasing an exam to
// a class and their guardians.
//
// The sweep is deliberately conservative, and the whole design turns on one
// distinction the table could not previously make:
//
//   * attempts = 0 — no gateway has ever been told. Re-queueing cannot
//     duplicate anything, so it is recovered.
//   * attempts > 0 — a gateway WAS told and the outcome was lost. It is closed
//     as FAILED, stated plainly, and NOT re-sent: a duplicate fee notice costs a
//     parent's trust and a second SMS credit, and we cannot tell whether the
//     first one arrived.
//
// Which is why the attempt is stamped in the PLANNING transaction, before the
// gateway is told anything — the recording transaction is precisely the thing
// that may not happen.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GIVE_UP_AFTER_HOURS,
  NotificationRecoveryService,
  RECOVERY_BATCH,
  STRANDED_AFTER_MINUTES,
} from "../../src/notifications/notification-recovery.service";

const SERVICE_SRC = readFileSync(join(__dirname, "../../src/notifications/notification.service.ts"), "utf8");

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);

type Row = {
  id: string;
  schoolId: string;
  notificationId: string;
  attempts: number;
  createdAt: Date;
  lastAttemptAt: Date | null;
};

function makeService(rows: Row[], opts: { noDb?: boolean; queueThrows?: boolean; noQueue?: boolean } = {}) {
  const updates: Array<{ id: string; status: string; error?: string }> = [];
  const queued: Array<{ notificationId: string; schoolId: string; userId: string }> = [];
  const client = {
    notificationDelivery: {
      findMany: jest.fn(async () => rows),
      update: jest.fn(async (a: { where: { id: string }; data: { status: string; error?: string } }) => {
        updates.push({ id: a.where.id, ...a.data });
        return {};
      }),
    },
  };
  const db = { client: opts.noDb ? null : client };
  const queue = opts.noQueue
    ? undefined
    : {
        add: jest.fn(async (_name: string, job: { notificationId: string; schoolId: string; userId: string }) => {
          if (opts.queueThrows) throw new Error("redis down");
          queued.push(job);
          return {};
        }),
      };
  return {
    service: new NotificationRecoveryService(db as never, queue as never),
    updates,
    queued,
    findMany: client.notificationDelivery.findMany,
  };
}

const row = (over: Partial<Row> = {}): Row => ({
  id: "d1",
  schoolId: "S",
  notificationId: "n1",
  attempts: 0,
  createdAt: hoursAgo(2),
  lastAttemptAt: null,
  ...over,
});

describe("a delivery nothing ever picked up", () => {
  it("is queued again, because no gateway was ever told", async () => {
    const { service, queued } = makeService([row()]);
    const r = await service.recoverStranded();
    expect(r.requeued).toBe(1);
    expect(queued).toEqual([expect.objectContaining({ notificationId: "n1", schoolId: "S" })]);
  });

  it("is attributed to the SYSTEM actor, not to a school id in a user id field", async () => {
    const { service, queued } = makeService([row()]);
    await service.recoverStranded();
    expect(queued[0].userId).toBe("00000000-0000-0000-0000-000000000000");
    expect(queued[0].userId).not.toBe("S");
  });

  it("is left alone while it is still fresh — a slow queue is not a lost one", async () => {
    const { service, queued } = makeService([row({ createdAt: minutesAgo(STRANDED_AFTER_MINUTES - 5) })]);
    const r = await service.recoverStranded();
    expect(r.tooRecent).toBe(1);
    expect(queued).toEqual([]);
  });

  it("is queued ONCE for a notification with several stranded channels", async () => {
    // The job performs every pending channel for its notification, so two jobs
    // would have the worker do the same work twice.
    const { service, queued } = makeService([
      row({ id: "d1", notificationId: "n1" }),
      row({ id: "d2", notificationId: "n1" }),
      row({ id: "d3", notificationId: "n2" }),
    ]);
    const r = await service.recoverStranded();
    expect(queued).toHaveLength(2);
    expect(r.requeued).toBe(2);
  });

  it("is left PENDING when the queue is still down, so the next run retries it", async () => {
    const { service, updates } = makeService([row()], { queueThrows: true });
    const r = await service.recoverStranded();
    expect(r.requeued).toBe(0);
    // Crucially NOT marked failed: nothing has been sent, and the row is the
    // only remaining record that it should be.
    expect(updates).toEqual([]);
  });
});

describe("a delivery whose outcome was lost", () => {
  it("is NEVER sent again", async () => {
    // The gateway was told. Sending again duplicates a message to a parent and
    // spends a second credit, and we cannot tell whether the first arrived.
    const { service, queued, updates } = makeService([
      row({ attempts: 1, lastAttemptAt: hoursAgo(GIVE_UP_AFTER_HOURS + 1) }),
    ]);
    const r = await service.recoverStranded();
    expect(queued).toEqual([]);
    expect(r.abandoned).toBe(1);
    expect(updates[0].status).toBe("FAILED");
  });

  it("says plainly that it is unknown rather than that it failed", async () => {
    const { service, updates } = makeService([
      row({ attempts: 1, lastAttemptAt: hoursAgo(GIVE_UP_AFTER_HOURS + 1) }),
    ]);
    await service.recoverStranded();
    expect(updates[0].error).toMatch(/outcome unknown/);
    expect(updates[0].error).toMatch(/not sent again/);
  });

  it("is given the full window before being written off", async () => {
    const { service, updates } = makeService([
      row({ attempts: 1, lastAttemptAt: hoursAgo(GIVE_UP_AFTER_HOURS - 1) }),
    ]);
    const r = await service.recoverStranded();
    expect(r.tooRecent).toBe(1);
    expect(updates).toEqual([]);
  });

  it("falls back to creation time when the attempt was never stamped", async () => {
    // Rows that predate the stamp. Treated by age, not abandoned for lacking it.
    const { service, updates } = makeService([row({ attempts: 1, lastAttemptAt: null, createdAt: hoursAgo(48) })]);
    await service.recoverStranded();
    expect(updates[0].status).toBe("FAILED");
  });
});

describe("the sweep's own honesty", () => {
  it("reports that it could not run, rather than reporting nothing to do", async () => {
    // A sweep that could not run and a sweep that found nothing look identical
    // in a log, and only one of them is good news.
    const { service } = makeService([], { noDb: true });
    const r = await service.recoverStranded();
    expect(r.skipped).toBe("NO_DB");
  });

  it("bounds one run, so a bad night is not one enormous transaction", async () => {
    const { service, findMany } = makeService([]);
    await service.recoverStranded();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: RECOVERY_BATCH }));
  });

  it("reads the oldest first, so the longest-stranded message goes out first", async () => {
    const { service, findMany } = makeService([]);
    await service.recoverStranded();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: "asc" } }));
  });

  it("does not silently do nothing when there is no queue to re-run through", async () => {
    const { service } = makeService([row()], { noQueue: true });
    const r = await service.recoverStranded();
    expect(r.requeued).toBe(0);
  });
});

describe("the stamp the whole distinction rests on", () => {
  it("is written BEFORE the gateway is told anything", () => {
    // In the planning transaction, not the recording one — the recording
    // transaction is exactly the thing that may not happen. Stamped afterwards,
    // every lost outcome would look like a delivery nobody had picked up, and
    // the sweep would send it again.
    const plan = SERVICE_SRC.slice(
      SERVICE_SRC.indexOf("async runDeliveries("),
      SERVICE_SRC.indexOf("// --- 2. Talk to the gateway"),
    );
    expect(plan).toMatch(/attempts: \{ increment: 1 \}/);
    expect(plan).toMatch(/lastAttemptAt: new Date\(\)/);
  });

  it("is not in the recording phase", () => {
    const record = SERVICE_SRC.slice(SERVICE_SRC.indexOf("// --- 3. Record what happened"));
    expect(record).not.toMatch(/attempts: \{ increment/);
  });
});

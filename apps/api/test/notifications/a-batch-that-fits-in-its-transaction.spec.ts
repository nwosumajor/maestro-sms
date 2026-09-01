/**
 * `enqueueMany` wrote every recipient in ONE interactive transaction, which is
 * capped at 5 seconds. Right for the ~100 of an exam release, and it FAILS
 * OUTRIGHT above a couple of thousand: announcing a scholarship to 5,000
 * candidates threw "Transaction already closed" for a school of 2,500, the
 * caller's catch swallowed it, and the operator was told 2,500 of 5,000 had
 * been notified.
 *
 * Measured on the running stack: 5,000 candidates went from ~45 s projected
 * (one transaction per recipient) to 12.3 s (batched, one school per
 * transaction, and failing) to 1.31 s with all 5,000 written.
 */
import { NotificationService } from "../../src/notifications/notification.service";
import { NOTIFY_CHUNK } from "../../src/notifications/notification.constants";

function harness(opts: { failOver?: number } = {}) {
  const txSizes: number[] = [];
  const created: string[] = [];
  const tx = {
    notification: {
      createMany: async ({ data }: { data: Array<{ recipientId: string }> }) => {
        txSizes.push(data.length);
        if (opts.failOver && data.length > opts.failOver) throw new Error("Transaction already closed");
        for (const d of data) created.push(d.recipientId);
        return { count: data.length };
      },
      create: async ({ data }: { data: { recipientId: string } }) => {
        created.push(data.recipientId);
        return { id: `n${created.length}`, ...data };
      },
    },
    notificationDelivery: { create: async () => ({}) },
    notificationPreference: { findFirst: async () => null },
    user: { findFirst: async () => ({ locale: null }) },
  };
  const svc = Object.create(NotificationService.prototype) as NotificationService;
  Object.assign(svc, {
    db: { runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx) },
    ctx: (a: unknown) => a,
    logger: { warn: () => undefined },
    queueDelivery: async () => undefined,
  });
  return { svc, txSizes, created };
}

const actor = { schoolId: "s1", userId: "u1" };
const many = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);

describe("a notification batch fits inside its transaction", () => {
  it("never puts more than one chunk in a single transaction", async () => {
    const { svc, txSizes } = harness();
    await svc.enqueueMany(actor, many(2500), { type: "SCHOLARSHIP", title: "t", body: "b" });
    expect(Math.max(...txSizes)).toBeLessThanOrEqual(NOTIFY_CHUNK);
    // And it is still a BATCH — one transaction per chunk, not one per
    // recipient, which is the whole point.
    expect(txSizes.length).toBe(Math.ceil(2500 / NOTIFY_CHUNK));
  });

  it("writes every recipient", async () => {
    const { svc, created } = harness();
    const out = await svc.enqueueMany(actor, many(2500), { type: "SCHOLARSHIP", title: "t", body: "b" });
    expect(out.created).toBe(2500);
    expect(out.failed).toBe(0);
    expect(new Set(created).size).toBe(2500);
  });

  // The old shape, reproduced: a transaction that took the whole batch would
  // have thrown, and the fix is that no transaction is ever that big.
  it("survives a store that refuses an over-large transaction", async () => {
    const { svc } = harness({ failOver: NOTIFY_CHUNK });
    const out = await svc.enqueueMany(actor, many(2500), { type: "SCHOLARSHIP", title: "t", body: "b" });
    expect(out.created).toBe(2500);
  });

  // A failed chunk is COUNTED, not dropped: the caller's total has to be what
  // actually went out, or a partial announce reads as a complete one.
  it("counts a failed chunk as failed rather than losing it", async () => {
    const { svc } = harness({ failOver: 1 });
    const out = await svc.enqueueMany(actor, many(10), { type: "SCHOLARSHIP", title: "t", body: "b" });
    expect(out.created).toBe(0);
    expect(out.failed).toBe(10);
  });

  it("de-duplicates, so one guardian of two candidates gets one notice", async () => {
    const { svc, created } = harness();
    await svc.enqueueMany(actor, ["g1", "g1", "g2"], { type: "SCHOLARSHIP", title: "t", body: "b" });
    expect(created).toEqual(["g1", "g2"]);
  });

  // The bulk insert is chosen ONLY when nothing about the row varies per
  // recipient. A localisation key or an external channel means per-recipient
  // work, and that must still go through `persist`.
  it("falls back to the per-recipient path when a channel is requested", async () => {
    const { svc, txSizes } = harness();
    await svc.enqueueMany(actor, many(3), {
      type: "SCHOLARSHIP",
      title: "t",
      body: "b",
      channels: ["EMAIL"] as never,
    });
    // createMany was never used — the sizes array stays empty.
    expect(txSizes).toEqual([]);
  });
});

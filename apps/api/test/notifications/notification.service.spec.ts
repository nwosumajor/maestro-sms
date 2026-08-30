// =============================================================================
// NotificationService — self-scoped inbox, send scoping, async delivery
// =============================================================================
// In-memory fakes (no DB / no Redis).
// =============================================================================

import { NotificationService } from "../../src/notifications/notification.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

interface Fakes {
  updateManyCount?: number;
  existing?: { id: string } | null;
  taughtClasses?: { classId: string }[];
  myStudents?: { studentId: string }[];
  guardian?: { id: string } | null;
  /** A stubbed `user` row carries `status`, as every real one does — the
   *  delivery worker now re-asks it at the wire (see the recovery window). */
  recipientUser?: { id: string; email?: string; status?: string } | null;
  pendingDeliveries?: { id: string; channel: string }[];
  notificationRow?: { id: string; recipientId: string; title: string; body: string; data: unknown } | null;
}

function makeService(f: Fakes, provider?: { deliver: jest.Mock }, credits?: { balanceInTx: jest.Mock; debitInTx: jest.Mock }) {
  const created = { id: "notif-1" };
  const tx = {
    notification: {
      create: jest.fn().mockResolvedValue(created),
      findFirst: jest.fn().mockResolvedValue(
        f.notificationRow === undefined ? null : f.notificationRow,
      ),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: f.updateManyCount ?? 0 }),
    },
    notificationDelivery: {
      create: jest.fn().mockResolvedValue({ id: "del-1" }),
      findMany: jest.fn().mockResolvedValue(f.pendingDeliveries ?? []),
      update: jest.fn().mockResolvedValue({}),
    },
    // Recipient preferences: null => the producer delivers all requested channels.
    notificationPreference: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findFirst: jest.fn().mockResolvedValue(f.recipientUser ?? null) },
    // One definition of who a teacher teaches (common/teaches.ts) asks all
    // three link tables; every real TenantTx answers all three.
    classTeacher: { findMany: jest.fn().mockResolvedValue(f.taughtClasses ?? []) },
    class: { findMany: jest.fn().mockResolvedValue([]) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue(f.myStudents ?? []) },
    parentChild: { findFirst: jest.fn().mockResolvedValue(f.guardian ?? null) },
  } as unknown as TenantTx;
  // markRead's "is it mine?" lookup uses notification.findFirst too:
  (tx.notification.findFirst as jest.Mock).mockResolvedValue(f.existing ?? f.notificationRow ?? null);

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const service = new NotificationService(
    db as never,
    audit as never,
    queue as never,
    provider as never,
    credits as never,
  );
  return { service, tx, queue, audit };
}

const principal = (roles: string[], userId = "u-1"): Principal => ({
  schoolId: "school-A",
  userId,
  roles,
  permissions: [],
});


/**
 * The update that RECORDS AN OUTCOME, not the one that stamps the attempt.
 *
 * Every attempt is now stamped before the gateway is told anything — that stamp
 * is what lets the recovery sweep tell a delivery nobody picked up from one
 * whose result was lost. It also means `calls[0]` is no longer the outcome, and
 * asking for the outcome by position was only ever right by accident.
 */
function outcomeWrite(tx: { notificationDelivery: { update: unknown } }) {
  const calls = (tx.notificationDelivery.update as jest.Mock).mock.calls;
  const hit = calls.map((c) => c[0].data).filter((d: { status?: string }) => d.status !== undefined);
  return hit[hit.length - 1];
}

describe("NotificationService", () => {
  it("listMine is scoped to the caller", async () => {
    const { service, tx } = makeService({});
    await service.listMine(principal(["student"], "me"));
    expect((tx.notification.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({
      recipientId: "me",
    });
  });

  it("markRead succeeds for the caller's own notification", async () => {
    const { service } = makeService({ updateManyCount: 1 });
    await expect(service.markRead(principal(["parent"], "me"), "n-1")).resolves.toEqual({
      id: "n-1",
      read: true,
    });
  });

  it("markRead on someone else's notification is 404", async () => {
    const { service } = makeService({ updateManyCount: 0, existing: null });
    await expect(service.markRead(principal(["parent"], "me"), "n-x")).rejects.toThrow(/not found/i);
  });

  it("teacher can send to a student they teach", async () => {
    const { service, queue } = makeService({
      taughtClasses: [{ classId: "c-1" }],
      myStudents: [{ studentId: "stu-1" }],
    });
    await service.send(principal(["teacher"]), {
      recipientId: "stu-1",
      type: "ANNOUNCEMENT",
      title: "Hi",
      body: "Reminder",
      channels: ["EMAIL"],
    });
    expect(queue.add).toHaveBeenCalled(); // delivery enqueued
  });

  it("teacher canNOT send to an unrelated user (403)", async () => {
    const { service } = makeService({
      taughtClasses: [{ classId: "c-1" }],
      myStudents: [{ studentId: "stu-1" }],
      guardian: null,
    });
    await expect(
      service.send(principal(["teacher"]), {
        recipientId: "stranger",
        type: "ANNOUNCEMENT",
        title: "Hi",
        body: "x",
      }),
    ).rejects.toThrow(/cannot send/i);
  });

  it("worker delivers a PENDING email via the provider -> SENT", async () => {
    const provider = { deliver: jest.fn().mockResolvedValue({ ok: true }) };
    const { service, tx } = makeService(
      {
        notificationRow: { id: "notif-1", recipientId: "r-1", title: "T", body: "B", data: null },
        recipientUser: { id: "r-1", status: "ACTIVE", email: "kid.parent@demo.school" },
        pendingDeliveries: [{ id: "del-1", channel: "EMAIL" }],
      },
      provider,
    );
    const res = await service.runDeliveries({
      schoolId: "school-A",
      userId: "sys",
      notificationId: "notif-1",
    });
    expect(provider.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "EMAIL", target: "kid.parent@demo.school" }),
    );
    expect(outcomeWrite(tx)).toMatchObject({
      status: "SENT",
    });
    expect(res).toEqual({ sent: 1, failed: 0 });
  });

  it("a CONFIRMED SMS send debits exactly one credit", async () => {
    const provider = { deliver: jest.fn().mockResolvedValue({ ok: true }) };
    const credits = { balanceInTx: jest.fn().mockResolvedValue(5), debitInTx: jest.fn().mockResolvedValue(undefined) };
    const { service } = makeService(
      {
        notificationRow: { id: "notif-1", recipientId: "r-1", title: "T", body: "B", data: null },
        recipientUser: { id: "r-1", status: "ACTIVE", phone: "+2348000000000" } as never,
        pendingDeliveries: [{ id: "del-1", channel: "SMS" }],
      },
      provider,
      credits,
    );
    const res = await service.runDeliveries({ schoolId: "school-A", userId: "sys", notificationId: "notif-1" });
    // Read ONCE per notification now — the allowance is shared out across its
    // channels rather than re-read per delivery.
    expect(credits.balanceInTx).toHaveBeenCalledTimes(1);
    expect(credits.debitInTx).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ sent: 1, failed: 0 });
  });

  it("records the OTHER outcomes when one of them cannot be written", async () => {
    // The blast-radius fix (#264). Recording used to be ONE transaction around
    // the whole loop, so a single failure rolled back every other outcome —
    // and those rows stay PENDING with an attempt stamped, which the recovery
    // sweep deliberately reads as "handed to a gateway, do NOT re-send". A
    // fan-out of delivered messages recorded as nothing, and no credit spent.
    const provider = { deliver: jest.fn().mockResolvedValue({ ok: true }) };
    const credits = {
      balanceInTx: jest.fn().mockResolvedValue(5),
      // The first debit blows up; `debitInTx` really does more than one write —
      // it appends a ledger row and then reads staff to warn about a low
      // balance — so this is the plumbing failing, not a contrived throw.
      debitInTx: jest.fn().mockRejectedValueOnce(new Error("ledger unavailable")).mockResolvedValue(undefined),
    };
    const { service } = makeService(
      {
        notificationRow: { id: "notif-1", recipientId: "r-1", title: "T", body: "B", data: null },
        recipientUser: { id: "r-1", status: "ACTIVE", phone: "+2348000000000" } as never,
        pendingDeliveries: [
          { id: "del-1", channel: "SMS" },
          { id: "del-2", channel: "SMS" },
        ],
      },
      provider,
      credits,
    );
    const res = await service.runDeliveries({ schoolId: "school-A", userId: "sys", notificationId: "notif-1" });
    // Both were sent by the gateway; one could not be written down. The other
    // is still counted, which is the whole point — it used to be neither.
    expect(provider.deliver).toHaveBeenCalledTimes(2);
    expect(res.sent).toBe(1);
  });

  it("a FAILED SMS send (gateway error) never debits a credit — no charge for no delivery", async () => {
    const provider = { deliver: jest.fn().mockResolvedValue({ ok: false, error: "twilio 500" }) };
    const credits = { balanceInTx: jest.fn().mockResolvedValue(5), debitInTx: jest.fn().mockResolvedValue(undefined) };
    const { service, tx } = makeService(
      {
        notificationRow: { id: "notif-1", recipientId: "r-1", title: "T", body: "B", data: null },
        recipientUser: { id: "r-1", status: "ACTIVE", phone: "+2348000000000" } as never,
        pendingDeliveries: [{ id: "del-1", channel: "SMS" }],
      },
      provider,
      credits,
    );
    const res = await service.runDeliveries({ schoolId: "school-A", userId: "sys", notificationId: "notif-1" });
    expect(credits.debitInTx).not.toHaveBeenCalled();
    expect(outcomeWrite(tx)).toMatchObject({
      status: "FAILED",
      error: "twilio 500",
    });
    expect(res).toEqual({ sent: 0, failed: 1 });
  });

  it("an empty credit balance fails the SMS soft WITHOUT calling the gateway at all", async () => {
    const provider = { deliver: jest.fn().mockResolvedValue({ ok: true }) };
    const credits = { balanceInTx: jest.fn().mockResolvedValue(0), debitInTx: jest.fn() };
    const { service, tx } = makeService(
      {
        notificationRow: { id: "notif-1", recipientId: "r-1", title: "T", body: "B", data: null },
        recipientUser: { id: "r-1", status: "ACTIVE", phone: "+2348000000000" } as never,
        pendingDeliveries: [{ id: "del-1", channel: "SMS" }],
      },
      provider,
      credits,
    );
    const res = await service.runDeliveries({ schoolId: "school-A", userId: "sys", notificationId: "notif-1" });
    expect(provider.deliver).not.toHaveBeenCalled(); // never attempted — never billed by the gateway either
    expect(credits.debitInTx).not.toHaveBeenCalled();
    expect(outcomeWrite(tx)).toMatchObject({
      status: "FAILED",
      error: expect.stringMatching(/no message credits/i),
    });
    expect(res).toEqual({ sent: 0, failed: 1 });
  });

  it("EMAIL delivery never touches credits (only SMS/WHATSAPP are metered)", async () => {
    const provider = { deliver: jest.fn().mockResolvedValue({ ok: true }) };
    const credits = { balanceInTx: jest.fn().mockResolvedValue(5), debitInTx: jest.fn() };
    const { service } = makeService(
      {
        notificationRow: { id: "notif-1", recipientId: "r-1", title: "T", body: "B", data: null },
        recipientUser: { id: "r-1", status: "ACTIVE", email: "kid.parent@demo.school" },
        pendingDeliveries: [{ id: "del-1", channel: "EMAIL" }],
      },
      provider,
      credits,
    );
    await service.runDeliveries({ schoolId: "school-A", userId: "sys", notificationId: "notif-1" });
    expect(credits.balanceInTx).not.toHaveBeenCalled();
    expect(credits.debitInTx).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// allowedChannels — pure preference-filtering (no DB)
// -----------------------------------------------------------------------------
import { allowedChannels } from "@sms/types";

describe("allowedChannels (notification preference filtering)", () => {
  const ALL = ["EMAIL", "SMS", "WHATSAPP"];

  it("no preference row => deliver all requested channels", () => {
    expect(allowedChannels(null, "ANNOUNCEMENT", ALL)).toEqual(ALL);
  });

  it("channel toggles drop the disabled channels", () => {
    const pref = { emailEnabled: false, smsEnabled: true, whatsappEnabled: false, mutedTypes: [] };
    expect(allowedChannels(pref, "ANNOUNCEMENT", ALL)).toEqual(["SMS"]);
  });

  it("a muted type drops ALL external channels", () => {
    const pref = { emailEnabled: true, smsEnabled: true, whatsappEnabled: true, mutedTypes: ["GRADE_PUBLISH"] };
    expect(allowedChannels(pref, "GRADE_PUBLISH", ALL)).toEqual([]);
    expect(allowedChannels(pref, "ANNOUNCEMENT", ALL)).toEqual(ALL);
  });

  it("an ESSENTIAL type ignores per-type mute but still respects channel toggles", () => {
    const pref = { emailEnabled: true, smsEnabled: false, whatsappEnabled: true, mutedTypes: ["PAYMENT_RECEIVED"] };
    // PAYMENT_RECEIVED is essential: mute is ignored, but SMS is still off.
    expect(allowedChannels(pref, "PAYMENT_RECEIVED", ALL)).toEqual(["EMAIL", "WHATSAPP"]);
  });
});

// =============================================================================
// The gateway call is not inside a transaction
// =============================================================================
// It used to be. The delivery loop ran inside `runAsTenant`, so a Twilio round
// trip was held open inside a Prisma interactive transaction whose default cap
// is five seconds — and the provider's `fetch` had no timeout at all, so a
// stalled socket could sit there indefinitely.
//
// When that cap fires the transaction ROLLS BACK, and the message has already
// gone: Twilio has taken it, the parent has read it, the platform has been
// billed. What is undone is our side — the SENT row and the credit debit — after
// which BullMQ retries the job and sends it AGAIN. Duplicate messages to
// families, double gateway spend, and a school under-charged for both.
// =============================================================================
describe("delivery does not hold a transaction open across the network", () => {
  it("reads the credit balance ONCE per notification, not per delivery", async () => {
    // The allowance replaced a per-delivery check. That check only worked
    // because each debit landed in the same transaction the next one read;
    // with the debits moved after the gateway calls, one read shared out is
    // what stops two channels spending the same last credit.
    const provider = { deliver: jest.fn().mockResolvedValue({ ok: true, providerRef: "SM1" }) };
    const credits = { balanceInTx: jest.fn().mockResolvedValue(5), debitInTx: jest.fn().mockResolvedValue(undefined) };
    const { service } = makeService(
      {
        notificationRow: { id: "notif-1", recipientId: "r-1", title: "T", body: "B", data: null },
        recipientUser: { id: "r-1", status: "ACTIVE", phone: "+2348000000000", contactEmail: "p@x.test" } as never,
        pendingDeliveries: [
          { id: "d-1", channel: "SMS" },
          { id: "d-2", channel: "WHATSAPP" },
        ],
      },
      provider,
      credits,
    );
    await service.runDeliveries({ schoolId: "s", userId: "u", notificationId: "notif-1" } as never);
    expect(credits.balanceInTx).toHaveBeenCalledTimes(1);
    expect(credits.debitInTx).toHaveBeenCalledTimes(2);
  });

  it("one credit does not pay for two metered channels", async () => {
    // The regression the restructure could have introduced: both attempts read
    // the same balance and both proceed. The allowance is decremented as it is
    // handed out, so the second is refused BEFORE the gateway is called.
    const provider = { deliver: jest.fn().mockResolvedValue({ ok: true, providerRef: "SM1" }) };
    const credits = { balanceInTx: jest.fn().mockResolvedValue(1), debitInTx: jest.fn().mockResolvedValue(undefined) };
    const { service } = makeService(
      {
        notificationRow: { id: "notif-1", recipientId: "r-1", title: "T", body: "B", data: null },
        recipientUser: { id: "r-1", status: "ACTIVE", phone: "+2348000000000", contactEmail: "p@x.test" } as never,
        pendingDeliveries: [
          { id: "d-1", channel: "SMS" },
          { id: "d-2", channel: "WHATSAPP" },
        ],
      },
      provider,
      credits,
    );
    const res = await service.runDeliveries({ schoolId: "s", userId: "u", notificationId: "notif-1" } as never);
    expect(provider.deliver).toHaveBeenCalledTimes(1); // the gateway is not even asked for the second
    expect(credits.debitInTx).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ sent: 1, failed: 1 });
  });
});

describe("the gateway call is bounded", () => {
  it("the SMS provider gives up rather than hanging", async () => {
    // Node's fetch has no default timeout. Without this a stalled socket pinned
    // the delivery worker, and — while the call was still inside the delivery
    // transaction — rolled back a message that had already been sent.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../src/notifications/twilio-channel.provider.ts"), "utf8");
    // The deadline now comes from the SHARED helper — this provider was the
    // only rail that had one, while the card gateways bounded /balance and left
    // every money call unbounded. See common/http.ts and the drift guard in
    // test/common/gateway-timeouts.spec.ts.
    expect(src).toMatch(/from "\.\.\/common\/http"/);
    // Both calls out to Twilio: the send AND the delivery-status read.
    expect(src.match(/fetchWithTimeout\(/g) ?? []).toHaveLength(2);
    expect(src).not.toMatch(/(?<![.\w])fetch\(/);
  });
});

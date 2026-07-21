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
  recipientUser?: { id: string; email?: string } | null;
  pendingDeliveries?: { id: string; channel: string }[];
  notificationRow?: { id: string; recipientId: string; title: string; body: string; data: unknown } | null;
}

function makeService(f: Fakes, provider?: { deliver: jest.Mock }, credits?: { hasBalanceInTx: jest.Mock; debitInTx: jest.Mock }) {
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
    classTeacher: { findMany: jest.fn().mockResolvedValue(f.taughtClasses ?? []) },
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
        recipientUser: { id: "r-1", email: "kid.parent@demo.school" },
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
    expect((tx.notificationDelivery.update as jest.Mock).mock.calls[0][0].data).toMatchObject({
      status: "SENT",
    });
    expect(res).toEqual({ sent: 1, failed: 0 });
  });

  it("a CONFIRMED SMS send debits exactly one credit", async () => {
    const provider = { deliver: jest.fn().mockResolvedValue({ ok: true }) };
    const credits = { hasBalanceInTx: jest.fn().mockResolvedValue(true), debitInTx: jest.fn().mockResolvedValue(undefined) };
    const { service } = makeService(
      {
        notificationRow: { id: "notif-1", recipientId: "r-1", title: "T", body: "B", data: null },
        recipientUser: { id: "r-1", phone: "+2348000000000" } as never,
        pendingDeliveries: [{ id: "del-1", channel: "SMS" }],
      },
      provider,
      credits,
    );
    const res = await service.runDeliveries({ schoolId: "school-A", userId: "sys", notificationId: "notif-1" });
    expect(credits.hasBalanceInTx).toHaveBeenCalledTimes(1);
    expect(credits.debitInTx).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ sent: 1, failed: 0 });
  });

  it("a FAILED SMS send (gateway error) never debits a credit — no charge for no delivery", async () => {
    const provider = { deliver: jest.fn().mockResolvedValue({ ok: false, error: "twilio 500" }) };
    const credits = { hasBalanceInTx: jest.fn().mockResolvedValue(true), debitInTx: jest.fn().mockResolvedValue(undefined) };
    const { service, tx } = makeService(
      {
        notificationRow: { id: "notif-1", recipientId: "r-1", title: "T", body: "B", data: null },
        recipientUser: { id: "r-1", phone: "+2348000000000" } as never,
        pendingDeliveries: [{ id: "del-1", channel: "SMS" }],
      },
      provider,
      credits,
    );
    const res = await service.runDeliveries({ schoolId: "school-A", userId: "sys", notificationId: "notif-1" });
    expect(credits.debitInTx).not.toHaveBeenCalled();
    expect((tx.notificationDelivery.update as jest.Mock).mock.calls[0][0].data).toMatchObject({
      status: "FAILED",
      error: "twilio 500",
    });
    expect(res).toEqual({ sent: 0, failed: 1 });
  });

  it("an empty credit balance fails the SMS soft WITHOUT calling the gateway at all", async () => {
    const provider = { deliver: jest.fn().mockResolvedValue({ ok: true }) };
    const credits = { hasBalanceInTx: jest.fn().mockResolvedValue(false), debitInTx: jest.fn() };
    const { service, tx } = makeService(
      {
        notificationRow: { id: "notif-1", recipientId: "r-1", title: "T", body: "B", data: null },
        recipientUser: { id: "r-1", phone: "+2348000000000" } as never,
        pendingDeliveries: [{ id: "del-1", channel: "SMS" }],
      },
      provider,
      credits,
    );
    const res = await service.runDeliveries({ schoolId: "school-A", userId: "sys", notificationId: "notif-1" });
    expect(provider.deliver).not.toHaveBeenCalled(); // never attempted — never billed by the gateway either
    expect(credits.debitInTx).not.toHaveBeenCalled();
    expect((tx.notificationDelivery.update as jest.Mock).mock.calls[0][0].data).toMatchObject({
      status: "FAILED",
      error: expect.stringMatching(/no message credits/i),
    });
    expect(res).toEqual({ sent: 0, failed: 1 });
  });

  it("EMAIL delivery never touches credits (only SMS/WHATSAPP are metered)", async () => {
    const provider = { deliver: jest.fn().mockResolvedValue({ ok: true }) };
    const credits = { hasBalanceInTx: jest.fn(), debitInTx: jest.fn() };
    const { service } = makeService(
      {
        notificationRow: { id: "notif-1", recipientId: "r-1", title: "T", body: "B", data: null },
        recipientUser: { id: "r-1", email: "kid.parent@demo.school" },
        pendingDeliveries: [{ id: "del-1", channel: "EMAIL" }],
      },
      provider,
      credits,
    );
    await service.runDeliveries({ schoolId: "school-A", userId: "sys", notificationId: "notif-1" });
    expect(credits.hasBalanceInTx).not.toHaveBeenCalled();
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

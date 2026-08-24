// =============================================================================
// The platform kept writing to people on behalf of schools it had switched off
// =============================================================================
// DISABLED means nobody at the school can sign in and it reaches nothing. The
// fee-reminder and late-fee sweeps had already been stopped for exactly this —
// "emailing them about the balance IN THE SCHOOL'S NAME while nobody there
// could sign in to see it, stop it, or answer a parent who rang" — but that was
// two sweeps, not the rule.
//
// Still going out: the hourly overdue-boarder alert to a family, a chargeback
// warning to finance, a document-expiry reminder to HR. Each invites a reply to
// a school that cannot read it and points at a login that will be refused.
//
// So the rule moves next to its twin, in `persist`: the ONE place a
// notification decides its external channels, already home to "nothing is sent
// to somebody who has left". A school being switched off is the same sentence
// one level up.
//
// THE INBOX ROW IS STILL WRITTEN. Disabling deletes nothing and reinstatement is
// total, so the notices a school missed belong to its "original and due state" —
// and they are unreadable meanwhile because nobody can sign in. Suppressing the
// record would make the switch destructive, which is the one thing it is not.
//
// OPERATOR ALERTS NEED NO EXCEPTION, which is worth stating because an
// exception is what would rot. They are enqueued into the PLATFORM org's own
// tenant, so the school being asked about is the platform, not the suspended
// school.
// =============================================================================

import { NotificationService } from "../../src/notifications/notification.service";
import type { TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(schoolIsActive: boolean, recipientStatus = "ACTIVE") {
  const deliveries: string[] = [];
  const tx = {
    notification: {
      create: jest.fn().mockResolvedValue({ id: "notif-1" }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    notificationDelivery: {
      create: jest.fn(({ data }: { data: { channel: string } }) => {
        deliveries.push(data.channel);
        return Promise.resolve({ id: "del-1" });
      }),
    },
    notificationPreference: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findFirst: jest.fn().mockResolvedValue({ status: recipientStatus }) },
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const isActive = jest.fn().mockResolvedValue(schoolIsActive);
  const service = new NotificationService(
    db as never,
    audit as never,
    queue as never,
    undefined,
    undefined,
    undefined,
    { isActive } as never,
  );
  return { service, tx, deliveries, audit, isActive };
}

const at = (schoolId: string): TenantContext => ({ schoolId, userId: "system" });
const overdueBoarder = {
  recipientId: "parent-1",
  type: "HOSTEL" as never,
  title: "Your child is overdue back from exeat",
  body: "Please contact the hostel.",
  channels: ["EMAIL", "SMS"] as never,
};

describe("an email and a text on behalf of a school that is switched off", () => {
  it("are not sent", async () => {
    const t = makeService(false);
    await t.service.enqueue(at("suspended-school"), overdueBoarder);
    expect(t.deliveries).toEqual([]);
  });

  it("but the inbox row IS written, because disabling deletes nothing", async () => {
    const t = makeService(false);
    await t.service.enqueue(at("suspended-school"), overdueBoarder);
    expect(t.tx.notification.create).toHaveBeenCalledTimes(1);
  });

  it("and the audit entry records that no channel was used", async () => {
    // "sent by email" in the trail for a message that never left would be worse
    // than the original bug — it is the record somebody checks afterwards.
    const t = makeService(false);
    await t.service.enqueue(at("suspended-school"), overdueBoarder);
    expect(t.audit.record.mock.calls[0][0].metadata).toMatchObject({ channels: [] });
  });

  it("goes out normally once the school is switched back on", async () => {
    // Reinstatement is total: nothing about the suppression is sticky.
    const t = makeService(true);
    await t.service.enqueue(at("live-school"), overdueBoarder);
    expect(t.deliveries).toEqual(["EMAIL", "SMS"]);
  });
});

describe("what the guard costs, and when it declines to act", () => {
  it("is not consulted at all for an in-app-only notification", async () => {
    // Most notifications request no external channel. Asking about the school
    // every time would add a lookup to the busiest path in the product.
    const t = makeService(false);
    await t.service.enqueue(at("suspended-school"), { ...overdueBoarder, channels: [] as never });
    expect(t.isActive).not.toHaveBeenCalled();
    expect(t.tx.notification.create).toHaveBeenCalled();
  });

  it("fails OPEN when no status service is wired", async () => {
    // Absent the dependency the answer is "we do not know", and silently
    // stopping every school's email on a missing wiring would be far worse than
    // the bug being fixed. Same posture as `credits` and `regions` here.
    const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    const deliveries: string[] = [];
    const tx = {
      notification: { create: jest.fn().mockResolvedValue({ id: "n" }), findFirst: jest.fn().mockResolvedValue(null) },
      notificationDelivery: {
        create: jest.fn(({ data }: { data: { channel: string } }) => {
          deliveries.push(data.channel);
          return Promise.resolve({});
        }),
      },
      notificationPreference: { findFirst: jest.fn().mockResolvedValue(null) },
      user: { findFirst: jest.fn().mockResolvedValue({ status: "ACTIVE" }) },
    } as unknown as TenantTx;
    const svc = new NotificationService(
      db as never,
      { record: jest.fn() } as never,
      { add: jest.fn() } as never,
    );
    await svc.enqueue(at("any-school"), overdueBoarder);
    expect(deliveries).toEqual(["EMAIL", "SMS"]);
  });

  it("fails OPEN when the status lookup throws", async () => {
    const t = makeService(true);
    t.isActive.mockRejectedValue(new Error("redis down"));
    await t.service.enqueue(at("live-school"), overdueBoarder);
    expect(t.deliveries).toEqual(["EMAIL", "SMS"]);
  });
});

describe("the two suppressions are independent", () => {
  it("a departed recipient at a live school is still suppressed", async () => {
    const t = makeService(true, "EXITED");
    await t.service.enqueue(at("live-school"), overdueBoarder);
    expect(t.deliveries).toEqual([]);
  });

  it("a live recipient at a switched-off school is suppressed too", async () => {
    const t = makeService(false, "ACTIVE");
    await t.service.enqueue(at("suspended-school"), overdueBoarder);
    expect(t.deliveries).toEqual([]);
  });
});

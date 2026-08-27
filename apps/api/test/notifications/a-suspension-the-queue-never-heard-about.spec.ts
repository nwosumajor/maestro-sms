// =============================================================================
// The guard was at creation; the bytes leave later
// =============================================================================
// `persist` drops external channels for a departed recipient and for a school
// that is switched off, and says it checks "once, HERE, rather than at each of
// the ~40 producers". That is the right place for the PRODUCERS — but it is
// CREATION time, and creation is not when the bytes leave.
//
// A delivery row sits PENDING until the worker runs, and a STRANDED one is
// re-queued by `NotificationRecoveryService` for up to GIVE_UP_AFTER_HOURS (24),
// swept hourly. Inside that window the operator can SUSPEND the school, or the
// recipient can EXIT — and the row, written when both were fine, was still sent:
// an email in the name of a school its owner had switched off, or an SMS
// spending a paid message credit on somebody who no longer works there.
//
// CLAUDE.md states the property as "Nothing reaches a switched-off school". The
// funnel enforced it; the queue went around it.
// =============================================================================

import { GIVE_UP_AFTER_HOURS, STRANDED_AFTER_MINUTES } from "../../src/notifications/notification-recovery.service";

describe("a suspension the queue never heard about", () => {
  it("leaves a window long enough to matter", () => {
    // Not a corner case measured in milliseconds: a row can be re-queued and
    // sent a full day after it was written and filtered.
    expect(STRANDED_AFTER_MINUTES).toBeGreaterThan(0);
    expect(GIVE_UP_AFTER_HOURS).toBeGreaterThanOrEqual(1);
  });

  it("does not send for a recipient who has since left", async () => {
    const { deliver, provider, outcomes } = await run({ recipientStatus: "EXITED", schoolActive: true });
    expect(deliver).toBe(false);
    expect(provider.deliver).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "FAILED", error: "recipient has left the school" });
  });

  it("does not send in the name of a school that has since been switched off", async () => {
    const { provider, outcomes } = await run({ recipientStatus: "ACTIVE", schoolActive: false });
    expect(provider.deliver).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "FAILED", error: "school is not active" });
  });

  it("still sends when both are fine", async () => {
    const { provider } = await run({ recipientStatus: "ACTIVE", schoolActive: true });
    expect(provider.deliver).toHaveBeenCalled();
  });

  it("fails OPEN when the school status cannot be read, exactly as persist does", async () => {
    // An absent dependency must not silently stop every school's mail.
    const { provider } = await run({ recipientStatus: "ACTIVE", schoolActive: null });
    expect(provider.deliver).toHaveBeenCalled();
  });

  it("records WHY nothing went, rather than reporting a quiet zero", async () => {
    const { outcomes } = await run({ recipientStatus: "EXITED", schoolActive: true });
    expect(outcomes.every((o) => typeof o.error === "string" && o.error.length > 0)).toBe(true);
  });
});

async function run(opts: { recipientStatus: string; schoolActive: boolean | null }) {
  const { NotificationService } = await import("../../src/notifications/notification.service");
  const outcomes: Array<{ status: string; error?: string }> = [];
  const tx = {
    notification: { findFirst: async () => ({ id: "n1", recipientId: "r1", title: "t", body: "b", type: "GENERAL" }) },
    user: { findFirst: async () => ({ email: "p@x.test", contactEmail: null, phone: null, status: opts.recipientStatus }) },
    notificationDelivery: {
      findMany: async () => [{ id: "d1", channel: "EMAIL" }],
      update: async (a: { data: { status: string; error?: string } }) => {
        outcomes.push(a.data);
        return a.data;
      },
    },
  };
  const provider = { deliver: jest.fn().mockResolvedValue({ ok: true }) };
  const svc = Object.create(NotificationService.prototype) as InstanceType<typeof NotificationService>;
  Object.assign(svc, {
    db: { runAsTenant: async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) },
    audit: { record: async () => undefined },
    channels: provider,
    credits: null,
    schoolStatus: opts.schoolActive === null ? undefined : { isActive: async () => opts.schoolActive },
  });
  await (svc as unknown as { runDeliveries: (j: unknown) => Promise<unknown> })
    .runDeliveries({ schoolId: "s1", notificationId: "n1" })
    .catch(() => undefined);
  return { deliver: provider.deliver.mock.calls.length > 0, provider, outcomes };
}

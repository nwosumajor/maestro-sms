// =============================================================================
// PaymentHealthService — would the owner actually find out?
// =============================================================================
// The switchboard answers "is it on" and "is a key set". Neither decays. This
// answers the one that does: does the key STILL work today. A key can be
// revoked, an account suspended for compliance review, a gateway down — all
// between the times anyone would think to press a test button.
//
// These cases pin the alerting BEHAVIOUR rather than the probe, because the
// probe is the rails' concern and the alerting is what decides whether a broken
// rail is noticed by the owner or by a parent.
// =============================================================================

import { PaymentHealthService } from "../../src/payments/payment-health.service";
import { PAYMENT_CHANNELS } from "@sms/types";

function makeService(opts: {
  enabled?: string[];
  previous?: Record<string, { ok: boolean; at: string; detail: string }>;
  results?: Record<string, { ok: boolean; detail: string }>;
  privileged?: boolean;
}) {
  const enabled = opts.enabled ?? [PAYMENT_CHANNELS.PAYSTACK];
  const update = jest.fn().mockResolvedValue({});
  const enqueue = jest.fn().mockResolvedValue({ id: "n-1" });
  const channels = {
    enabled: jest.fn().mockResolvedValue(enabled),
    testConnection: jest.fn(async (c: string) => ({
      channel: c,
      ...(opts.results?.[c] ?? { ok: true, detail: "Connected." }),
    })),
  };
  const privileged = {
    client:
      opts.privileged === false
        ? null
        : {
            paymentChannelConfigRow: { update },
            user: { findMany: jest.fn().mockResolvedValue([{ id: "owner-1", schoolId: "platform" }]) },
          },
  };
  const svc = new PaymentHealthService(channels as never, { enqueue } as never, privileged as never);
  // lastKnown() reads the prisma singleton; stub it so no DB is needed.
  jest.spyOn(svc, "lastKnown").mockResolvedValue((opts.previous ?? {}) as never);
  return { svc, update, enqueue, channels };
}

describe("PaymentHealthService", () => {
  afterEach(() => jest.restoreAllMocks());

  it("only checks rails that are SWITCHED ON", async () => {
    // A disabled channel with a broken key is not an incident — nobody can use
    // it anyway, and alerting on it trains the owner to dismiss these.
    const { svc, channels } = makeService({ enabled: [PAYMENT_CHANNELS.PAYSTACK] });
    await svc.run();
    expect(channels.testConnection).toHaveBeenCalledTimes(1);
    expect(channels.testConnection).toHaveBeenCalledWith(PAYMENT_CHANNELS.PAYSTACK);
  });

  it("ALERTS when a rail that was working breaks", async () => {
    const { svc, enqueue } = makeService({
      previous: { PAYSTACK: { ok: true, at: "yesterday", detail: "Connected." } },
      results: { PAYSTACK: { ok: false, detail: "Paystack rejected the key (401)." } },
    });
    const r = await svc.run();
    expect(r.broke).toEqual([PAYMENT_CHANNELS.PAYSTACK]);
    const alert = enqueue.mock.calls[0][1];
    expect(alert.type).toBe("OPERATOR_ALERT");
    expect(alert.title).toMatch(/Payments DOWN/);
    // The alert has to say what it MEANS, not just that a check failed: this
    // rail is switched on, so payers are being sent to it right now.
    expect(alert.body).toMatch(/SWITCHED ON/);
    expect(alert.body).toMatch(/401/);
  });

  it("alerts on a rail that has NEVER worked, not just one that regressed", async () => {
    // No previous reading. A rail enabled with a key that never worked is the
    // exact case this feature exists for.
    const { svc, enqueue } = makeService({
      previous: {},
      results: { PAYSTACK: { ok: false, detail: "PAYSTACK_SECRET_KEY is not set." } },
    });
    const r = await svc.run();
    expect(r.broke).toEqual([PAYMENT_CHANNELS.PAYSTACK]);
    expect(enqueue).toHaveBeenCalled();
  });

  it("does NOT alert again while it stays broken", async () => {
    // A nightly repeat of the same alarm is an alarm people learn to ignore.
    const { svc, enqueue } = makeService({
      previous: { PAYSTACK: { ok: false, at: "yesterday", detail: "401" } },
      results: { PAYSTACK: { ok: false, detail: "401" } },
    });
    const r = await svc.run();
    expect(r.broke).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not alert at all while everything stays healthy", async () => {
    const { svc, enqueue } = makeService({
      previous: { PAYSTACK: { ok: true, at: "yesterday", detail: "Connected." } },
      results: { PAYSTACK: { ok: true, detail: "Connected." } },
    });
    const r = await svc.run();
    expect({ broke: r.broke, recovered: r.recovered }).toEqual({ broke: [], recovered: [] });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("says so when a rail RECOVERS — closing the loop the first alert opened", async () => {
    const { svc, enqueue } = makeService({
      previous: { PAYSTACK: { ok: false, at: "yesterday", detail: "401" } },
      results: { PAYSTACK: { ok: true, detail: "Connected." } },
    });
    const r = await svc.run();
    expect(r.recovered).toEqual([PAYMENT_CHANNELS.PAYSTACK]);
    expect(enqueue.mock.calls[0][1].title).toMatch(/recovered/i);
  });

  it("never treats MOBILE MONEY's un-probeable answer as an outage", async () => {
    // It reports not-ok because it cannot be tested, not because it is broken.
    // Counting that as DOWN would alert every single night, for ever.
    const { svc, enqueue } = makeService({
      enabled: [PAYMENT_CHANNELS.MOBILE_MONEY],
      results: {
        MOBILE_MONEY: { ok: false, detail: "Mobile money cannot be tested from here — confirm with a sandbox charge." },
      },
    });
    const r = await svc.run();
    expect(r.broke).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a sweep that could not RUN is not a sweep that found everything healthy", async () => {
    const { svc, enqueue } = makeService({ privileged: false });
    const r = await svc.run();
    expect(r).toMatchObject({ skipped: true, checked: [], broke: [] });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("persists the reading so the operator screen never has to call a gateway", async () => {
    const { svc, update } = makeService({ results: { PAYSTACK: { ok: true, detail: "Connected." } } });
    await svc.run();
    const written = update.mock.calls[0][0].data.health as Record<string, { ok: boolean }>;
    expect(written.PAYSTACK.ok).toBe(true);
  });
});

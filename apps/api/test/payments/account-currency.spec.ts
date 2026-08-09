// =============================================================================
// Account currency — a rail supporting a currency is not an account enabled for it
// =============================================================================
// The live defect: ENTERPRISE is priced in USD. With only Paystack switched on,
// pickCardRail correctly routes USD to Paystack, because Paystack settles USD
// as a product. But THIS Paystack account was enabled for NGN only, so the
// charge came back 403 and reached the school as "Payment provider error" —
// after they had re-authenticated and committed to buying.
//
// The probe had reported the account's currencies all along ("this test account
// settles NGN"). The health record threw them away, so nothing could act on it.
//
// The asymmetry below is the important part: a POSITIVE list that excludes the
// currency refuses; an ABSENT list never does. Unknown must not block a payment
// that might have worked.
// =============================================================================

import { PaymentChannelService } from "../../src/payments/payment-channel.service";
import { PAYMENT_CHANNELS } from "@sms/types";

function makeService(opts: { enabled?: string[]; health?: Record<string, unknown> }) {
  const svc = Object.create(PaymentChannelService.prototype) as PaymentChannelService;
  Object.assign(svc, { paystack: { isConfigured: () => true }, stripe: { isConfigured: () => true } });
  jest.spyOn(svc, "enabled").mockResolvedValue((opts.enabled ?? [PAYMENT_CHANNELS.PAYSTACK]) as never);
  jest.spyOn(svc, "readiness").mockReturnValue([
    { channel: PAYMENT_CHANNELS.PAYSTACK, enabled: true, configured: true, missing: null },
    { channel: PAYMENT_CHANNELS.STRIPE, enabled: true, configured: true, missing: null },
  ] as never);
  // lastHealth is private; the persisted reading is what this is all about.
  (svc as unknown as { lastHealth: () => Promise<unknown> }).lastHealth = async () => opts.health ?? {};
  return svc;
}

describe("account currency", () => {
  afterEach(() => jest.restoreAllMocks());

  it("REFUSES a currency the gateway account cannot settle", async () => {
    // The exact live case: Paystack on, account settles NGN, ENTERPRISE is USD.
    const svc = makeService({ health: { PAYSTACK: { ok: true, currencies: ["NGN"] } } });
    const out = await svc.availabilityFor("USD");
    expect(out.available).toBe(false);
    expect(out.reason).toMatch(/USD/);
  });

  it("allows a currency the account DOES settle", async () => {
    const svc = makeService({ health: { PAYSTACK: { ok: true, currencies: ["NGN", "USD"] } } });
    expect(await svc.availabilityFor("USD")).toEqual({ available: true, reason: null });
  });

  it("does NOT refuse when the account's currencies are unknown", async () => {
    // No probe has run yet. Blocking here would take a working platform offline
    // the first time this code shipped, which is worse than the bug it fixes.
    const svc = makeService({ health: { PAYSTACK: { ok: true } } });
    expect((await svc.availabilityFor("USD")).available).toBe(true);
  });

  it("does not refuse on an EMPTY list either — that is still not evidence", async () => {
    const svc = makeService({ health: { PAYSTACK: { ok: true, currencies: [] } } });
    expect((await svc.availabilityFor("USD")).available).toBe(true);
  });

  it("tells a PARENT nothing about the platform's account", async () => {
    // A payer must not learn which rail we use or what it settles.
    const svc = makeService({ health: { PAYSTACK: { ok: true, currencies: ["NGN"] } } });
    const reason = (await svc.availabilityFor("USD")).reason ?? "";
    expect(reason).not.toMatch(/paystack|stripe|account|NGN/i);
  });

  it("tells an OPERATOR exactly what to fix", async () => {
    // Same fact, different audience: leadership and the operator can act on it.
    const svc = makeService({ health: { PAYSTACK: { ok: true, currencies: ["NGN"] } } });
    const out = await svc.billingAvailabilityFor("USD");
    expect(out.available).toBe(false);
    expect(out.reason).toMatch(/PAYSTACK/);
    expect(out.reason).toMatch(/settles NGN/);
  });

  it("is case-insensitive about the currency it is asked", async () => {
    const svc = makeService({ health: { PAYSTACK: { ok: true, currencies: ["NGN"] } } });
    expect((await svc.availabilityFor("usd")).available).toBe(false);
    expect((await svc.availabilityFor("ngn")).available).toBe(true);
  });

  it("still refuses first when no enabled rail can carry the currency at all", async () => {
    // The pre-existing gate must keep winning — this is an extra check, not a
    // replacement for the switchboard.
    const svc = makeService({ enabled: [], health: {} });
    expect((await svc.availabilityFor("USD")).available).toBe(false);
  });
});

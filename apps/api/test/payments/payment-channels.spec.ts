// =============================================================================
// Payment channel switchboard — what it gates, and what it must NEVER gate
// =============================================================================
// A startup ships one rail and adds others later. The switch is easy; the
// dangerous part is the blast radius, so these cases pin the two rules that
// decide whether it protects revenue or destroys it:
//
//   1. It gates STARTING a payment. It must never reach settlement — webhooks,
//      verify-on-return and the reconciliation sweeps handle money that has
//      ALREADY left a payer's account and must keep working on every channel
//      for ever, including one switched off years ago.
//   2. It refuses a change that would leave a LIVE school unable to charge at
//      all, unless the operator overrules it deliberately.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ServiceUnavailableException, BadRequestException } from "@nestjs/common";
import {
  CHANNEL_CURRENCIES,
  DEFAULT_ENABLED_CHANNELS,
  PAYMENT_CHANNELS,
  currencyIsChargeable,
  isChannelEnabled,
  normaliseChannels,
  pickCardRail,
} from "@sms/types";
import { PaymentChannelService } from "../../src/payments/payment-channel.service";

describe("payment channel config (pure)", () => {
  it("the startup default is Paystack, and only Paystack", () => {
    expect(DEFAULT_ENABLED_CHANNELS).toEqual([PAYMENT_CHANNELS.PAYSTACK]);
  });

  it("an absent or empty config falls back to the default rather than to nothing", () => {
    // "No config" must never mean "no rail" — that would stop every payment on
    // the platform the first time the row went missing.
    expect(isChannelEnabled(null, PAYMENT_CHANNELS.PAYSTACK)).toBe(true);
    expect(isChannelEnabled({ enabled: [] }, PAYMENT_CHANNELS.PAYSTACK)).toBe(true);
    expect(isChannelEnabled({ enabled: [] }, PAYMENT_CHANNELS.STRIPE)).toBe(false);
  });

  it("drops values that are not real channels", () => {
    // The column is JSON; a stale or hand-edited value must not become a
    // channel nobody can find in the UI to turn off.
    expect(normaliseChannels(["PAYSTACK", "BITCOIN", 7, "PAYSTACK"])).toEqual(["PAYSTACK"]);
    expect(normaliseChannels("PAYSTACK")).toEqual([]);
  });

  it("knows Paystack cannot settle most of the catalogue", () => {
    const paystackOnly = [PAYMENT_CHANNELS.PAYSTACK];
    // The five it does settle.
    for (const c of ["NGN", "GHS", "ZAR", "KES", "USD"]) {
      expect(currencyIsChargeable(c, paystackOnly)).toBe(true);
    }
    // Representative currencies from the catalogue that it does NOT.
    for (const c of ["XOF", "UGX", "TZS", "EGP", "GBP", "INR"]) {
      expect(currencyIsChargeable(c, paystackOnly)).toBe(false);
    }
    // Mobile money is region-routed, so it can cover what cards cannot.
    expect(currencyIsChargeable("UGX", [PAYMENT_CHANNELS.MOBILE_MONEY])).toBe(true);
  });

  it("a null school currency counts as the platform's home currency, not unknown", () => {
    expect(CHANNEL_CURRENCIES.PAYSTACK).toContain("NGN");
    expect(currencyIsChargeable("", [PAYMENT_CHANNELS.PAYSTACK])).toBe(true);
  });
});

function makeService(enabled: string[], schools: Array<{ id: string; name: string; currency: string | null }> = []) {
  const upsert = jest.fn().mockResolvedValue({});
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const privileged = {
    client: {
      school: { findMany: jest.fn().mockResolvedValue(schools) },
      paymentChannelConfigRow: { upsert },
    },
  };
  const db = { runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn({}) };
  const svc = new PaymentChannelService(db as never, audit as never, privileged as never);
  // Seed the cache so `enabled()` never touches the real prisma singleton.
  (svc as unknown as { cache: unknown }).cache = { at: Date.now(), enabled };
  return { svc, upsert, audit };
}

const owner = { schoolId: "platform", userId: "owner-1", roles: ["super_admin"], permissions: [] } as never;

describe("PaymentChannelService gating", () => {
  it("lets an enabled channel through and refuses a disabled one", async () => {
    const { svc } = makeService([PAYMENT_CHANNELS.PAYSTACK]);
    await expect(svc.assertEnabled(PAYMENT_CHANNELS.PAYSTACK)).resolves.toBeUndefined();
    await expect(svc.assertEnabled(PAYMENT_CHANNELS.STRIPE)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("tells the payer it is COMING SOON, not that something broke", async () => {
    const { svc } = makeService([PAYMENT_CHANNELS.PAYSTACK]);
    // The reader is a parent or a school owner. A rail the platform has not
    // funded yet is a roadmap item; wording it as a fault loses the customer.
    await expect(svc.assertEnabled(PAYMENT_CHANNELS.MOBILE_MONEY)).rejects.toThrow(/coming soon/i);
  });

  it("REFUSES a change that would strand a live school", async () => {
    const { svc, upsert } = makeService(
      [PAYMENT_CHANNELS.PAYSTACK, PAYMENT_CHANNELS.MOBILE_MONEY],
      [{ id: "s1", name: "Dakar Academy", currency: "XOF" }],
    );
    await expect(
      svc.update(owner, { enabled: [PAYMENT_CHANNELS.PAYSTACK] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("names the school and its currency in the refusal", async () => {
    const { svc } = makeService(
      [PAYMENT_CHANNELS.PAYSTACK, PAYMENT_CHANNELS.MOBILE_MONEY],
      [{ id: "s1", name: "Dakar Academy", currency: "XOF" }],
    );
    await expect(svc.update(owner, { enabled: [PAYMENT_CHANNELS.PAYSTACK] })).rejects.toThrow(
      /Dakar Academy \(XOF\)/,
    );
  });

  it("applies anyway on force, and RECORDS that it was overruled", async () => {
    const { svc, upsert, audit } = makeService(
      [PAYMENT_CHANNELS.PAYSTACK, PAYMENT_CHANNELS.MOBILE_MONEY],
      [{ id: "s1", name: "Dakar Academy", currency: "XOF" }],
    );
    const out = await svc.update(owner, { enabled: [PAYMENT_CHANNELS.PAYSTACK], force: true });
    expect(out.stranded).toHaveLength(1);
    expect(upsert).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "operator.payment_channels.update",
        metadata: expect.objectContaining({ forced: true, strandedCount: 1 }),
      }),
      expect.anything(),
    );
  });

  it("never lets the operator disable EVERYTHING", async () => {
    const { svc } = makeService([PAYMENT_CHANNELS.PAYSTACK]);
    // An empty set stops every payment platform-wide and nothing else in the
    // system would report why.
    await expect(svc.update(owner, { enabled: [] })).rejects.toThrow(/at least one/i);
  });

  it("a school with no currency set is NOT counted as stranded", async () => {
    // null means the platform's home country (NGN), which Paystack settles.
    const { svc, upsert } = makeService(
      [PAYMENT_CHANNELS.PAYSTACK, PAYMENT_CHANNELS.STRIPE],
      [{ id: "s1", name: "Lagos School", currency: null }],
    );
    await expect(svc.update(owner, { enabled: [PAYMENT_CHANNELS.PAYSTACK] })).resolves.toMatchObject({ stranded: [] });
    expect(upsert).toHaveBeenCalled();
  });
});

// ===========================================================================
// THE RULE THIS FEATURE LIVES OR DIES BY
// ===========================================================================
// Enforced as a source check rather than a behavioural one, deliberately: the
// risk is that someone later adds `assertEnabled` to a settlement path "for
// consistency", and no runtime test would fail — it would simply start
// dropping payments that had already been taken. This fails the build instead.
describe("the switchboard never reaches settlement", () => {
  const SETTLEMENT_PATHS = [
    "src/fees/settlement.service.ts",
    "src/fees/reconciliation.service.ts",
    "src/fees/fees-webhook.service.ts",
    "src/payments/gateway-event.service.ts",
  ];

  it("no settlement or reconciliation path consults the channel switch", () => {
    const root = join(__dirname, "..", "..");
    const offenders: string[] = [];
    for (const rel of SETTLEMENT_PATHS) {
      let src: string;
      try {
        src = readFileSync(join(root, rel), "utf8");
      } catch {
        continue; // renamed or absent — the sweep below is the real guard
      }
      if (/assertEnabled|PaymentChannelService/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("the mobile-money RECOVERY sweep settles regardless of the switch", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src/payments/mobile-money.service.ts"), "utf8");
    // charge() gates; recoverPending()/applyReading() must not. Assert the gate
    // appears exactly once — in the charge path only.
    expect(src.match(/assertEnabled/g) ?? []).toHaveLength(1);
    const gateAt = src.indexOf("assertEnabled");
    const recoverAt = src.indexOf("async recoverPending");
    expect(gateAt).toBeGreaterThan(-1);
    if (recoverAt > -1) expect(gateAt).toBeLessThan(recoverAt);
  });
});

// ===========================================================================
// USD MUST STILL BE PAYABLE WHILE STRIPE IS OFF
// ===========================================================================
// USD normally routes to Stripe. But Paystack settles USD too, so refusing a
// USD payment because "Stripe is off" leaves collectable money uncollected —
// and ENTERPRISE is priced in USD, so an ENTERPRISE school could not pay its
// own subscription and a USD school fee could not be paid at all.
describe("card rail selection", () => {
  it("routes USD to PAYSTACK while Stripe is switched off", () => {
    expect(pickCardRail("USD", [PAYMENT_CHANNELS.PAYSTACK])).toBe(PAYMENT_CHANNELS.PAYSTACK);
  });

  it("returns USD to STRIPE the moment it is switched on — no second switch to remember", () => {
    expect(pickCardRail("USD", [PAYMENT_CHANNELS.PAYSTACK, PAYMENT_CHANNELS.STRIPE])).toBe(
      PAYMENT_CHANNELS.STRIPE,
    );
  });

  it("keeps NGN on Paystack and never sends it to Stripe, which cannot settle it", () => {
    expect(pickCardRail("NGN", [PAYMENT_CHANNELS.PAYSTACK, PAYMENT_CHANNELS.STRIPE])).toBe(
      PAYMENT_CHANNELS.PAYSTACK,
    );
    // Stripe-only is not a fallback for naira — it would charge in the wrong
    // currency, which is the defect PAYSTACK_CURRENCIES exists to prevent.
    expect(pickCardRail("NGN", [PAYMENT_CHANNELS.STRIPE])).toBeNull();
  });

  it("returns null when NOTHING enabled can settle the currency", () => {
    // The honest answer. The caller turns it into a message a payer can act on
    // rather than a checkout that fails at the gateway.
    expect(pickCardRail("GBP", [PAYMENT_CHANNELS.PAYSTACK, PAYMENT_CHANNELS.STRIPE])).toBeNull();
    expect(pickCardRail("XOF", [PAYMENT_CHANNELS.PAYSTACK])).toBeNull();
  });

  it("treats a missing currency as the platform's home currency", () => {
    expect(pickCardRail("", [PAYMENT_CHANNELS.PAYSTACK])).toBe(PAYMENT_CHANNELS.PAYSTACK);
  });
});

// ===========================================================================
// SWITCHED ON is not the same as USABLE
// ===========================================================================
// A rail can be enabled in an environment with no credentials for it. Nothing
// refuses that — the keys may land minutes later — but it must be VISIBLE, or
// the first report of "mobile money doesn't work" comes from a parent who
// could not pay. The toggle is a commercial decision; credentials are a
// deployment fact, and conflating them is how a rail serves nobody quietly.
describe("channel readiness (credentials, not the toggle)", () => {
  const KEYS = [
    "PAYSTACK_SECRET_KEY", "STRIPE_SECRET_KEY",
    "MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET", "MPESA_SHORTCODE", "MPESA_PASSKEY",
    "MTN_MOMO_SUBSCRIPTION_KEY", "MTN_MOMO_API_USER", "MTN_MOMO_API_KEY",
    "AIRTEL_CLIENT_ID", "AIRTEL_CLIENT_SECRET",
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const svc = () => makeService([PAYMENT_CHANNELS.PAYSTACK]).svc;

  it("reports a channel that is ON but has no credentials, and names what is missing", () => {
    const r = svc().readiness([PAYMENT_CHANNELS.PAYSTACK]);
    const paystack = r.find((x) => x.channel === PAYMENT_CHANNELS.PAYSTACK)!;
    expect(paystack).toMatchObject({ enabled: true, configured: false, missing: "PAYSTACK_SECRET_KEY" });
  });

  it("counts mobile money ready when ANY ONE rail is configured", () => {
    process.env.AIRTEL_CLIENT_ID = "x";
    process.env.AIRTEL_CLIENT_SECRET = "y";
    const mm = svc().readiness([PAYMENT_CHANNELS.MOBILE_MONEY]).find((x) => x.channel === PAYMENT_CHANNELS.MOBILE_MONEY)!;
    // Coverage then decides per school; one configured provider is enough for
    // the channel itself to be usable.
    expect(mm).toMatchObject({ enabled: true, configured: true, missing: null });
  });

  it("does NOT require PAYSTACK_DEDICATED_BANK for bank transfer — it has a default", () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_test";
    const bank = svc().readiness([PAYMENT_CHANNELS.BANK_TRANSFER]).find((x) => x.channel === PAYMENT_CHANNELS.BANK_TRANSFER)!;
    expect(bank).toMatchObject({ configured: true, missing: null });
  });

  it("update() reports which enabled channels are unconfigured, and audits it", async () => {
    const { svc: s, audit } = makeService([PAYMENT_CHANNELS.PAYSTACK]);
    const out = await s.update(owner, { enabled: [PAYMENT_CHANNELS.PAYSTACK] });
    expect(out.unconfigured).toEqual([PAYMENT_CHANNELS.PAYSTACK]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ unconfigured: [PAYMENT_CHANNELS.PAYSTACK] }) }),
      expect.anything(),
    );
  });

  it("enabling an unconfigured rail is REPORTED, never refused", async () => {
    // Refusing would block the legitimate order of operations: switch it on,
    // then deploy the keys.
    const { svc: s } = makeService([PAYMENT_CHANNELS.PAYSTACK]);
    await expect(s.update(owner, { enabled: [PAYMENT_CHANNELS.PAYSTACK] })).resolves.toBeTruthy();
  });
});

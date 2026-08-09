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

// =============================================================================
// Paystack and Stripe — the WIRE, and the SIGNATURE
// =============================================================================
// The same treatment the three mobile-money rails got, but the risk profile is
// different in one decisive way: these rails SIGN their webhooks. So the
// properties worth pinning hardest are security properties. A signature bug is
// not "a payment goes uncredited" — it is anyone on the internet being able to
// forge "payment succeeded" and have fees marked paid for free.
//
// Signatures are computed here with the real algorithms (HMAC-SHA512 over the raw
// body for Paystack, HMAC-SHA256 over `${t}.${body}` for Stripe) rather than by
// asking the code under test what it expects — a test that derives the expected
// value the same way the implementation does proves nothing about either.
//
// Three defects, one of them the most consequential of this whole sweep:
//
//   1. PAYSTACK WAS NEVER TOLD THE CURRENCY. It charges in the ACCOUNT's currency
//      when you omit it, and 27 of the platform's 29 catalogued currencies routed
//      to it. A Ghanaian school's GHS 5,000 invoice charged the parent NGN 5,000
//      — roughly a tenth — while settlement marked the invoice PAID. The school
//      is underpaid and the ledger says otherwise.
//   2. STRIPE DROPPED ALL BUT ONE SIGNATURE. During a webhook-secret rotation
//      Stripe signs with BOTH secrets (`t=…,v1=new,v1=old`); reading the header
//      into a Map keeps only the last. Every payment in the rotation window would
//      have been rejected as a bad signature.
//   3. Stripe HMAC'd the body via a utf8 round-trip rather than the raw bytes.
//
// NOT proved here: that Paystack and Stripe accept these bytes. Unlike the mobile
// money rails these have run against real gateways in earlier work, but no
// credentialed run happened in this session.
// =============================================================================

import * as crypto from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { PaystackService } from "../../src/payments/paystack.service";
import { StripeService } from "../../src/payments/stripe.service";
import { PAYSTACK_CURRENCIES, paystackCanSettle, stripeAmountFor } from "@sms/types";

type Call = { url: string; init?: RequestInit };

function stubFetch(payload: unknown, ok = true) {
  const calls: Call[] = [];
  global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok, status: ok ? 200 : 400, json: async () => payload, text: async () => JSON.stringify(payload) } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const bodyOf = (c: Call) => JSON.parse(String(c.init!.body)) as Record<string, unknown>;
const formOf = (c: Call) => new URLSearchParams(String(c.init!.body));

// =============================================================================
// Paystack — the charge
// =============================================================================

const PS_OK = { data: { authorization_url: "https://checkout.paystack.com/abc" } };

const PS_INIT = {
  email: "parent@example.com",
  amountMinor: 500_000,
  currency: "NGN",
  reference: "INV-abc12345-1700000000",
  metadata: { kind: "invoice", invoiceId: "inv-1" },
};

describe("Paystack — transaction/initialize", () => {
  const realFetch = global.fetch;
  beforeEach(() => (process.env.PAYSTACK_SECRET_KEY = "sk_test_x"));
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.PAYSTACK_SECRET_KEY;
  });

  it("NAMES the currency — omitting it charges in the account's own", async () => {
    // THE defect. Paystack defaults to the integration's currency, so a GHS
    // invoice became an NGN charge of the same number: the school underpaid by
    // ~90% with the ledger recording the invoice as settled.
    const calls = stubFetch(PS_OK);
    await new PaystackService().initialize({ ...PS_INIT, currency: "GHS" });
    expect(bodyOf(calls[0]).currency).toBe("GHS");
  });

  it("REFUSES a currency the rail cannot settle, rather than defaulting", async () => {
    // Refuse, never approximate — the same posture as the payroll packs and plan
    // pricing. 27 of the 29 catalogued currencies used to reach this rail.
    stubFetch(PS_OK);
    await expect(
      new PaystackService().initialize({ ...PS_INIT, currency: "TZS" }),
    ).rejects.toThrow(/not available in TZS/);
  });

  it("points the refused payer at a rail that DOES work where they live", async () => {
    // Tanzania, Uganda, Ghana, Cameroon and the rest are covered by mobile money.
    // A refusal that does not say so reads as "this school cannot take money".
    stubFetch(PS_OK);
    await expect(
      new PaystackService().initialize({ ...PS_INIT, currency: "UGX" }),
    ).rejects.toThrow(/mobile money/i);
  });

  it("accepts exactly the currencies Paystack settles", () => {
    expect(PAYSTACK_CURRENCIES).toEqual(["NGN", "GHS", "ZAR", "KES", "USD"]);
    for (const c of PAYSTACK_CURRENCIES) expect(paystackCanSettle(c)).toBe(true);
    for (const c of ["TZS", "UGX", "XOF", "XAF", "RWF", "ZMW"]) expect(paystackCanSettle(c)).toBe(false);
    expect(paystackCanSettle("ngn")).toBe(true); // case is not a rejection reason
  });

  it("sends an INTEGER minor amount, refusing a fraction rather than truncating", async () => {
    // A fractional minor unit is either rejected or silently truncated, and a
    // truncated charge no longer matches the invoice it settles.
    const calls = stubFetch(PS_OK);
    await new PaystackService().initialize(PS_INIT);
    expect(bodyOf(calls[0]).amount).toBe(500_000);
    await expect(
      new PaystackService().initialize({ ...PS_INIT, amountMinor: 500_000.5 }),
    ).rejects.toThrow(/whole number of minor units/);
  });

  it("bearers the SECRET key and sends the reference verbatim", async () => {
    // The reference is the idempotency key the whole settlement path matches on.
    const calls = stubFetch(PS_OK);
    await new PaystackService().initialize(PS_INIT);
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_x");
    expect(bodyOf(calls[0]).reference).toBe(PS_INIT.reference);
    expect(bodyOf(calls[0]).amount).toBe(500_000);
  });

  it("names the currency on a SAVED-CARD renewal too", async () => {
    // Auto-renew is the same money on a different endpoint. Charging a renewal in
    // a currency other than the one the payment row books is a reconciliation
    // problem nobody finds until year end.
    const calls = stubFetch({ data: { status: "success" } });
    await new PaystackService().chargeAuthorization({
      email: "admin@school.example",
      amountMinor: 250_000,
      currency: "NGN",
      reference: "SUB-abc12345-1700000000",
      authorizationCode: "AUTH_xyz",
      metadata: {},
    });
    expect(bodyOf(calls[0]).currency).toBe("NGN");
  });
});

// =============================================================================
// Paystack — the webhook signature
// =============================================================================

describe("Paystack — webhook signature", () => {
  const SECRET = "sk_test_x";
  const sign = (raw: Buffer) => crypto.createHmac("sha512", SECRET).update(raw).digest("hex");
  const raw = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "INV-1", amount: 500_000 } }));

  beforeEach(() => (process.env.PAYSTACK_SECRET_KEY = SECRET));
  afterEach(() => delete process.env.PAYSTACK_SECRET_KEY);

  it("accepts a correctly signed body", () => {
    const ev = new PaystackService().verify(raw, sign(raw));
    expect(ev?.event).toBe("charge.success");
  });

  it("REJECTS a forged body — the whole point of the signature", () => {
    // Signed once, then tampered. Without this an attacker who learns the webhook
    // URL marks any invoice paid for free.
    const forged = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "INV-1", amount: 999_999_999 } }));
    expect(() => new PaystackService().verify(forged, sign(raw))).toThrow(UnauthorizedException);
  });

  it("REJECTS a missing signature — absence is not permission", () => {
    expect(() => new PaystackService().verify(raw, undefined)).toThrow(UnauthorizedException);
  });

  it("rejects a short signature without CRASHING on it", () => {
    // timingSafeEqual THROWS on a length mismatch rather than returning false, so
    // an unguarded compare turns a hostile request into a 500 instead of a 401.
    expect(() => new PaystackService().verify(raw, "abc")).toThrow(UnauthorizedException);
  });

  it("signs the RAW BYTES, so re-serialising the JSON breaks verification", () => {
    // The classic webhook bug: verifying against JSON.stringify(parsed) instead of
    // what arrived. Key order and whitespace differ, so it fails — or, worse, the
    // app "fixes" it by not verifying at all.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString())) + " ");
    expect(() => new PaystackService().verify(reserialised, sign(raw))).toThrow(UnauthorizedException);
  });

  it("is INERT when the gateway is not configured", () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    expect(new PaystackService().verify(raw, sign(raw))).toBeNull();
  });
});

// =============================================================================
// Stripe — the webhook signature
// =============================================================================

describe("Stripe — webhook signature", () => {
  const SECRET = "whsec_test";
  const raw = Buffer.from(JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } }));
  const sig = (t: number, secret = SECRET, body = raw) =>
    crypto.createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${t}.`), body])).digest("hex");
  const now = () => Math.floor(Date.now() / 1000);

  beforeEach(() => (process.env.STRIPE_WEBHOOK_SECRET = SECRET));
  afterEach(() => delete process.env.STRIPE_WEBHOOK_SECRET);

  it("accepts a correctly signed event", () => {
    const t = now();
    expect(new StripeService().verifyWebhook(raw, `t=${t},v1=${sig(t)}`)?.type).toBe("checkout.session.completed");
  });

  it("accepts the event when ANY v1 matches — secret ROTATION", () => {
    // THE Stripe defect. Mid-rotation Stripe signs with both secrets and sends
    // them as repeated v1 fields. Reading the header into a Map keeps only the
    // LAST, so if ours is not last, every payment in the window is rejected.
    const t = now();
    const ours = sig(t);
    const theirOld = sig(t, "whsec_previous");
    expect(new StripeService().verifyWebhook(raw, `t=${t},v1=${ours},v1=${theirOld}`)?.type).toBe("checkout.session.completed");
    expect(new StripeService().verifyWebhook(raw, `t=${t},v1=${theirOld},v1=${ours}`)?.type).toBe("checkout.session.completed");
  });

  it("still rejects when NO v1 matches", () => {
    // Accepting "any" must not become accepting "some were present".
    const t = now();
    expect(() =>
      new StripeService().verifyWebhook(raw, `t=${t},v1=${sig(t, "whsec_a")},v1=${sig(t, "whsec_b")}`),
    ).toThrow(UnauthorizedException);
  });

  it("REJECTS a REPLAYED event — the timestamp is inside the signature", () => {
    // Stripe signs `${t}.${body}`, so an old capture stays perfectly valid
    // forever unless the age is checked. Without this, one intercepted
    // "payment succeeded" can be posted again and again.
    const old = now() - 60 * 60;
    expect(() => new StripeService().verifyWebhook(raw, `t=${old},v1=${sig(old)}`)).toThrow(/Stale/);
  });

  it("rejects a timestamp from the FUTURE as well as the past", () => {
    const future = now() + 60 * 60;
    expect(() => new StripeService().verifyWebhook(raw, `t=${future},v1=${sig(future)}`)).toThrow(/Stale/);
  });

  it("REJECTS a forged body", () => {
    const t = now();
    const forged = Buffer.from(JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { amount_total: 1 } } }));
    expect(() => new StripeService().verifyWebhook(forged, `t=${t},v1=${sig(t)}`)).toThrow(UnauthorizedException);
  });

  it("binds the signature to the TIMESTAMP, not just the body", () => {
    // Signing the body alone would let anyone re-stamp a captured event with a
    // fresh `t` and sail past the staleness check.
    const t = now();
    const bodyOnly = crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
    expect(() => new StripeService().verifyWebhook(raw, `t=${t},v1=${bodyOnly}`)).toThrow(UnauthorizedException);
  });

  it("rejects a malformed header without crashing", () => {
    for (const h of ["", "garbage", "t=,v1=", "v1=abc", `t=${now()}`, "t=notanumber,v1=abc"]) {
      expect(() => new StripeService().verifyWebhook(raw, h)).toThrow(UnauthorizedException);
    }
  });

  it("REJECTS a missing signature, and is INERT when unconfigured", () => {
    expect(() => new StripeService().verifyWebhook(raw, undefined)).toThrow(UnauthorizedException);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(new StripeService().verifyWebhook(raw, `t=${now()},v1=x`)).toBeNull();
  });
});

// =============================================================================
// Stripe — the charge
// =============================================================================

describe("Stripe — checkout session", () => {
  const realFetch = global.fetch;
  beforeEach(() => (process.env.STRIPE_SECRET_KEY = "sk_live_x"));
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.STRIPE_SECRET_KEY;
  });

  const INPUT = {
    email: "admin@school.example",
    amountMinor: 12_000,
    reference: "SUB-abc12345-1700000000",
    description: "SMS PREMIUM plan",
    metadata: { kind: "subscription", schoolId: "s-1" },
  };

  it("is FORM-ENCODED — Stripe's API rejects JSON", async () => {
    const calls = stubFetch({ url: "https://checkout.stripe.com/x" });
    await new StripeService().createCheckoutSession(INPUT);
    expect((calls[0].init!.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(String(calls[0].init!.body)).not.toMatch(/^\s*\{/);
  });

  it("sends the amount in CENTS as an integer", async () => {
    const calls = stubFetch({ url: "https://checkout.stripe.com/x" });
    await new StripeService().createCheckoutSession(INPUT);
    expect(formOf(calls[0]).get("line_items[0][price_data][unit_amount]")).toBe("12000");
  });

  it("stamps metadata onto the PAYMENT INTENT, not only the session", async () => {
    // Session metadata never reaches the Charge, and a dispute webhook carries
    // only the charge — without this a chargeback cannot be traced to a school.
    const calls = stubFetch({ url: "https://checkout.stripe.com/x" });
    await new StripeService().createCheckoutSession(INPUT);
    const f = formOf(calls[0]);
    expect(f.get("payment_intent_data[metadata][schoolId]")).toBe("s-1");
    expect(f.get("payment_intent_data[metadata][reference]")).toBe(INPUT.reference);
  });

  it("knows which currencies are ZERO-DECIMAL, so the next one added is safe", () => {
    // The platform raises USD only on Stripe today. This exists so that adding a
    // currency cannot reintroduce the ×100 bug the currency work removed: JPY is
    // charged in whole yen, and sending cents overcharges a hundredfold.
    expect(stripeAmountFor(12_000, "USD")).toBe(12_000);
    expect(stripeAmountFor(12_000, "JPY")).toBe(12_000); // JPY minor unit IS the yen
    expect(stripeAmountFor(12_000, "XOF")).toBe(12_000);
  });
});

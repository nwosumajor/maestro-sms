// =============================================================================
// MTN MoMo and Airtel Money — the WIRE, against each provider's published API
// =============================================================================
// The same treatment M-Pesa got, and for the same reason: asserting a request
// against a fixture shaped like our own code proves only that the code is
// self-consistent. These assert against what MTN and Airtel actually document,
// and against their real callback bodies.
//
// It found, between them, four more defects — one of which had exactly the shape
// of the M-Pesa bug (payer debited, invoice never credited):
//
//   1. MTN's callback is a PUT. The route accepted only POST, so MoMo's
//      notification would have 404'd. Fixed in the controller, pinned below.
//   2. MTN's X-Reference-Id was not a valid UUIDv4 — the version and variant
//      nibbles were whatever fell out of our reference (`…-5d06-ca00-…`).
//   3. MTN's sandbox only settles EUR; sending the school's real currency there
//      is rejected, which reads as a broken integration rather than a sandbox.
//   4. AIRTEL WANTS A NATIONAL MSISDN. Every other rail wants the international
//      form, and our normaliser produces it. Airtel takes the country separately
//      and would have rejected `254…` on every single charge.
//
// Still NOT proved: that MTN or Airtel accept these bytes. Neither sandbox has
// been exercised — see the mobile-money-rail note and the PR.
// =============================================================================

import {
  AirtelProvider,
  MtnMomoProvider,
  airtelNationalMsisdn,
  mtnReferenceId,
} from "../../src/payments/mobile-money.provider";

type Call = { url: string; init?: RequestInit };

function stubFetch(final: unknown, status = 200) {
  const calls: Call[] = [];
  global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "tok_123" }) } as unknown as Response;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => final,
      text: async () => JSON.stringify(final),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const REQUEST = {
  reference: "MM-3F2A9C41B7E85D06CA",
  amountMinor: 50_000,
  currency: "GHS",
  msisdn: "233241234567",
  country: "GH",
  dialCode: "233",
  narrative: "School fees for the second term",
  callbackUrl: "https://school.example/payments/mobile-money/callback/mtn_momo",
};

const headersOf = (c: Call) => c.init!.headers as Record<string, string>;
const bodyOf = (c: Call) => JSON.parse(String(c.init!.body)) as Record<string, unknown>;

// =============================================================================
// MTN MoMo
// =============================================================================

const MTN_ENV = {
  MTN_MOMO_SUBSCRIPTION_KEY: "sub_key",
  MTN_MOMO_API_USER: "api_user",
  MTN_MOMO_API_KEY: "api_key",
};

describe("MTN MoMo — requesttopay", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    for (const k of Object.keys(MTN_ENV)) delete process.env[k];
    delete process.env.MTN_MOMO_ENV;
    delete process.env.MTN_MOMO_TARGET;
  });
  beforeEach(() => Object.assign(process.env, MTN_ENV));

  it("sends a WELL-FORMED UUIDv4 as X-Reference-Id", async () => {
    // MTN types the field as a uuid. The old derivation left our reference's own
    // nibbles in the version and variant positions, producing `…-5d06-ca00-…`,
    // which a strict validator refuses.
    const calls = stubFetch({}, 202);
    await new MtnMomoProvider().charge(REQUEST);
    const id = headersOf(calls[1])["X-Reference-Id"];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("derives that id from OUR reference, so a retry is idempotent at MTN's end", () => {
    // X-Reference-Id is MTN's idempotency key. Freshly random per attempt would
    // prompt the payer twice for one invoice; deriving it means MTN rejects the
    // duplicate itself.
    expect(mtnReferenceId(REQUEST.reference)).toBe(mtnReferenceId(REQUEST.reference));
    expect(mtnReferenceId("MM-AAAA")).not.toBe(mtnReferenceId("MM-BBBB"));
  });

  it("treats 202 Accepted — with an EMPTY body — as success", async () => {
    // requesttopay answers 202 and no body at all. Reading a success flag out of
    // the response would fail every time, on every successful charge.
    const calls = stubFetch({}, 202);
    const ack = await new MtnMomoProvider().charge(REQUEST);
    expect(ack.providerRef).toBe(headersOf(calls[1])["X-Reference-Id"]);
  });

  it("rejects any other 2xx — 200 is NOT the success code here", async () => {
    // MoMo signals "accepted for processing" with 202 specifically. A 200 means
    // something else answered, and treating it as success tells the payer a prompt
    // is on its way when none is.
    stubFetch({ message: "OK" }, 200);
    await expect(new MtnMomoProvider().charge(REQUEST)).rejects.toThrow(/refused/);
  });

  it("sends the mandatory subscription key and target environment on BOTH calls", async () => {
    const calls = stubFetch({}, 202);
    await new MtnMomoProvider().charge(REQUEST);
    expect(headersOf(calls[0])["Ocp-Apim-Subscription-Key"]).toBe("sub_key");
    expect(headersOf(calls[0]).Authorization).toBe(`Basic ${Buffer.from("api_user:api_key").toString("base64")}`);
    expect(headersOf(calls[1])["Ocp-Apim-Subscription-Key"]).toBe("sub_key");
    expect(headersOf(calls[1])["X-Target-Environment"]).toBe("sandbox");
    expect(headersOf(calls[1]).Authorization).toBe("Bearer tok_123");
  });

  it("sends EUR in the sandbox, which settles nothing else", async () => {
    // Sending GHS to the sandbox is rejected — and looks like our bug, not theirs.
    const calls = stubFetch({}, 202);
    await new MtnMomoProvider().charge(REQUEST);
    expect(bodyOf(calls[1]).currency).toBe("EUR");
  });

  it("sends the REAL currency in production", async () => {
    process.env.MTN_MOMO_ENV = "production";
    process.env.MTN_MOMO_TARGET = "mtnghana";
    const calls = stubFetch({}, 202);
    await new MtnMomoProvider().charge(REQUEST);
    expect(bodyOf(calls[1]).currency).toBe("GHS");
    expect(headersOf(calls[1])["X-Target-Environment"]).toBe("mtnghana");
    expect(calls[1].url).toContain("proxy.momoapi.mtn.com");
  });

  it("sends the amount as a STRING in major units", async () => {
    // MoMo's schema types amount as a string. A number is rejected.
    const calls = stubFetch({}, 202);
    await new MtnMomoProvider().charge(REQUEST);
    expect(bodyOf(calls[1]).amount).toBe("500");
    expect(typeof bodyOf(calls[1]).amount).toBe("string");
  });

  it("does not divide a zero-decimal currency by 100", async () => {
    // 50,000 UGX is 50,000 shillings, not 500. This is the CFA-franc bug that the
    // currency work removed platform-wide, and it must not come back per-rail.
    const calls = stubFetch({}, 202);
    await new MtnMomoProvider().charge({ ...REQUEST, currency: "UGX", country: "UG", dialCode: "256" });
    expect(bodyOf(calls[1]).amount).toBe("50000");
  });

  it("sends the INTERNATIONAL msisdn — MTN's form, unlike Airtel's", async () => {
    const calls = stubFetch({}, 202);
    await new MtnMomoProvider().charge(REQUEST);
    expect(bodyOf(calls[1]).payer).toEqual({ partyIdType: "MSISDN", partyId: "233241234567" });
    expect(bodyOf(calls[1]).externalId).toBe(REQUEST.reference);
  });

  it("is DISABLED, not half-working, without credentials", async () => {
    for (const k of Object.keys(MTN_ENV)) delete process.env[k];
    const p = new MtnMomoProvider();
    expect(p.isConfigured()).toBe(false);
    await expect(p.charge(REQUEST)).rejects.toThrow(/not configured/);
  });
});

describe("MTN MoMo — the callback body MTN actually sends", () => {
  const provider = new MtnMomoProvider();

  // The transaction object as documented for the requesttopay callback.
  const SUCCESS = {
    financialTransactionId: "23503452",
    externalId: "MM-3F2A9C41B7E85D06CA",
    amount: "500",
    currency: "GHS",
    payer: { partyIdType: "MSISDN", partyId: "233241234567" },
    status: "SUCCESSFUL",
  };

  it("recovers our reference from externalId — MTN DOES echo it", () => {
    // Unlike Daraja. Worth stating explicitly: the two rails differ, and assuming
    // they match is how the M-Pesa bug happened.
    const r = provider.readCallback(SUCCESS);
    expect(r.reference).toBe("MM-3F2A9C41B7E85D06CA");
    expect(r.outcome).toBe("SUCCEEDED");
    expect(r.providerRef).toBe("23503452");
  });

  it("reads SUCCESSFUL — not SUCCESS, which is a different rail's word", () => {
    expect(provider.readCallback({ ...SUCCESS, status: "SUCCESS" }).outcome).not.toBe("SUCCEEDED");
    expect(provider.readCallback({ ...SUCCESS, status: "SUCCESSFUL" }).outcome).toBe("SUCCEEDED");
  });

  it("reads a failure with MTN's reason", () => {
    const r = provider.readCallback({ ...SUCCESS, status: "FAILED", reason: "PAYER_LIMIT_REACHED" });
    expect(r.outcome).toBe("FAILED");
    expect(r.failureReason).toBe("PAYER_LIMIT_REACHED");
  });

  it("holds anything it cannot read at PENDING rather than guessing", () => {
    for (const junk of [{}, null, "nope", { status: "ONGOING" }]) {
      expect(provider.readCallback(junk).outcome).toBe("PENDING");
    }
  });
});

// =============================================================================
// Airtel Money
// =============================================================================

const AIRTEL_ENV = { AIRTEL_CLIENT_ID: "cid", AIRTEL_CLIENT_SECRET: "csec" };

const AIRTEL_REQUEST = {
  ...REQUEST,
  currency: "KES",
  msisdn: "254712345678",
  country: "KE",
  dialCode: "254",
};

const AIRTEL_OK = {
  data: { transaction: { id: "MM-3F2A9C41B7E85D06CA", status: "SUCCESS" } },
  status: { response_code: "DP00800001006", code: "200", success: true, result_code: "ESB000010", message: "SUCCESS" },
};

describe("Airtel Money — collection request", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    for (const k of Object.keys(AIRTEL_ENV)) delete process.env[k];
    delete process.env.AIRTEL_ENV;
  });
  beforeEach(() => Object.assign(process.env, AIRTEL_ENV));

  it("sends the NATIONAL msisdn, with the dial code taken back off", async () => {
    // THE Airtel defect. Every other rail wants 254712345678 and our normaliser
    // produces exactly that; Airtel takes the country separately and wants
    // 712345678. Sending the international form fails every charge.
    const calls = stubFetch(AIRTEL_OK);
    await new AirtelProvider().charge(AIRTEL_REQUEST);
    expect((bodyOf(calls[1]).subscriber as Record<string, unknown>).msisdn).toBe("712345678");
  });

  it("strips the right number of digits per country, never a guessed length", () => {
    expect(airtelNationalMsisdn("254712345678", "254")).toBe("712345678");
    expect(airtelNationalMsisdn("237671234567", "237")).toBe("671234567"); // Cameroon
    expect(airtelNationalMsisdn("712345678", "254")).toBe("712345678"); // already national
  });

  it("authenticates with a JSON POST, NOT Basic auth", async () => {
    // The difference from both other rails. Sending Basic here returns a 401 that
    // looks like bad credentials.
    const calls = stubFetch(AIRTEL_OK);
    await new AirtelProvider().charge(AIRTEL_REQUEST);
    expect(calls[0].init!.method).toBe("POST");
    expect(headersOf(calls[0]).Authorization).toBeUndefined();
    expect(bodyOf(calls[0])).toEqual({
      client_id: "cid",
      client_secret: "csec",
      grant_type: "client_credentials",
    });
  });

  it("sends the mandatory X-Country and X-Currency headers", async () => {
    // Airtel routes on these, not on the number's prefix — which is precisely why
    // the msisdn is national.
    const calls = stubFetch(AIRTEL_OK);
    await new AirtelProvider().charge(AIRTEL_REQUEST);
    expect(headersOf(calls[1])["X-Country"]).toBe("KE");
    expect(headersOf(calls[1])["X-Currency"]).toBe("KES");
    expect(headersOf(calls[1]).Authorization).toBe("Bearer tok_123");
  });

  it("puts OUR reference in transaction.id, which Airtel echoes back", async () => {
    const calls = stubFetch(AIRTEL_OK);
    await new AirtelProvider().charge(AIRTEL_REQUEST);
    expect(bodyOf(calls[1]).transaction).toEqual({
      amount: 500,
      country: "KE",
      currency: "KES",
      id: REQUEST.reference,
    });
  });

  it("treats a 200 carrying success:false as a FAILURE", async () => {
    // Airtel answers 200 with status.success false. Trusting the HTTP status
    // reports a prompt as sent that never left Airtel.
    stubFetch({ status: { success: false, message: "Invalid MSISDN" } });
    await expect(new AirtelProvider().charge(AIRTEL_REQUEST)).rejects.toThrow(/Invalid MSISDN/);
  });

  it("defaults to UAT unless production is asked for by name", async () => {
    const calls = stubFetch(AIRTEL_OK);
    await new AirtelProvider().charge(AIRTEL_REQUEST);
    expect(calls.every((c) => c.url.startsWith("https://openapiuat.airtel.africa"))).toBe(true);

    process.env.AIRTEL_ENV = "production";
    const prod = stubFetch(AIRTEL_OK);
    await new AirtelProvider().charge(AIRTEL_REQUEST);
    expect(prod.every((c) => c.url.startsWith("https://openapi.airtel.africa"))).toBe(true);
  });

  it("is DISABLED, not half-working, without credentials", async () => {
    for (const k of Object.keys(AIRTEL_ENV)) delete process.env[k];
    const p = new AirtelProvider();
    expect(p.isConfigured()).toBe(false);
    await expect(p.charge(AIRTEL_REQUEST)).rejects.toThrow(/not configured/);
  });

  it("refuses a fractional amount rather than rounding it onto the payer", async () => {
    stubFetch(AIRTEL_OK);
    await expect(
      new AirtelProvider().charge({ ...AIRTEL_REQUEST, amountMinor: 50_050 }),
    ).rejects.toThrow(/whole units/);
  });
});

describe("Airtel Money — the callback body Airtel actually sends", () => {
  const provider = new AirtelProvider();
  const base = { id: "MM-3F2A9C41B7E85D06CA", airtel_money_id: "MP210603.1234.L06941" };

  it("reads TS as success and recovers our reference", () => {
    const r = provider.readCallback({ transaction: { ...base, message: "Success", status_code: "TS" } });
    expect(r).toMatchObject({
      reference: "MM-3F2A9C41B7E85D06CA",
      outcome: "SUCCEEDED",
      providerRef: "MP210603.1234.L06941",
    });
  });

  it("reads TF as failed, with Airtel's message", () => {
    const r = provider.readCallback({
      transaction: { ...base, message: "Insufficient balance", status_code: "TF" },
    });
    expect(r.outcome).toBe("FAILED");
    expect(r.failureReason).toBe("Insufficient balance");
  });

  it("treats TA — AMBIGUOUS — as still pending, never as paid", () => {
    // "We do not know" must not post money. Airtel uses TA when it cannot yet say,
    // and the safe reading is the one that leaves the invoice alone.
    expect(provider.readCallback({ transaction: { ...base, status_code: "TA" } }).outcome).toBe("PENDING");
  });

  it("holds anything it cannot read at PENDING", () => {
    for (const junk of [{}, null, "nope", { transaction: {} }]) {
      expect(provider.readCallback(junk).outcome).toBe("PENDING");
    }
  });
});

// =============================================================================
// The route both rails must reach
// =============================================================================

describe("the callback route accepts BOTH verbs", () => {
  it("registers POST and PUT as separate handlers", () => {
    // MTN's documented callback for requesttopay is a PUT. The route accepted only
    // POST, so the notification would have 404'd — the M-Pesa failure shape again:
    // payer debited, invoice never credited, nothing but an access log to show it.
    //
    // Asserted on the source because Nest's @Post and @Put write the SAME metadata
    // key: stacking both on one handler silently keeps only one, which would have
    // looked exactly like a fix.
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "..", "src", "payments", "mobile-money.controller.ts"),
      "utf8",
    ) as string;
    expect(src).toContain('@Post("callback/:provider")');
    expect(src).toContain('@Put("callback/:provider")');
    // Two distinct handler methods, not two decorators on one.
    expect(/@Put\("callback\/:provider"\)\s*\n\s*(\w+)\(/.exec(src)?.[1]).toBe("callbackPut");
  });
});

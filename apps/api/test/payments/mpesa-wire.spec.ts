// =============================================================================
// M-Pesa — the WIRE, asserted against Safaricom's published Daraja contract
// =============================================================================
// This is the closest thing to a sandbox charge that can run without Safaricom
// credentials, and it is the part worth automating anyway: a sandbox run tells
// you it worked TODAY, on one machine, for whoever had the keys. These assertions
// tell you it still works on every commit, forever, in CI.
//
// It pins the request byte-for-byte against the documented STK-push contract, and
// feeds the adapter Daraja's REAL callback body. Two defects were found writing
// it, both of which a hurried sandbox poke could easily have missed:
//
//   1. THE CALLBACK COULD NEVER BE MATCHED. Daraja does not echo AccountReference;
//      its CallbackMetadata carries only Amount, MpesaReceiptNumber,
//      TransactionDate and PhoneNumber. The adapter looked for AccountReference,
//      so every real payment would have been debited from the payer and never
//      credited to the invoice. Now matched on CheckoutRequestID.
//   2. A FRACTIONAL BALANCE OVERCHARGED THE PAYER. Daraja rejects decimals, and
//      the adapter rounded — so a KES 500.50 balance debited 501 and credited
//      500.50. The ask is now floored to whole units in the service.
//
// What is still NOT proved here: that Safaricom accepts these bytes. Only their
// sandbox can say that. See the header of mobile-money.service.spec.ts.
// =============================================================================

import { MpesaProvider } from "../../src/payments/mobile-money.provider";

/** Safaricom's published sandbox test MSISDN. */
const TEST_MSISDN = "254708374149";

const ENV = {
  MPESA_CONSUMER_KEY: "ck_test",
  MPESA_CONSUMER_SECRET: "cs_test",
  MPESA_SHORTCODE: "174379",
  // The passkey Safaricom publishes for the sandbox shortcode.
  MPESA_PASSKEY: "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919",
};

type Call = { url: string; init?: RequestInit };

function stubFetch(stkResponse: unknown, ok = true) {
  const calls: Call[] = [];
  global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/oauth/")) {
      return { ok: true, json: async () => ({ access_token: "tok_123" }) } as unknown as Response;
    }
    return { ok, json: async () => stkResponse } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

/** The body actually sent to the STK-push endpoint. */
function stkBody(calls: Call[]): Record<string, unknown> {
  const push = calls.find((c) => c.url.includes("/mpesa/stkpush/"));
  if (!push) throw new Error("no STK push was sent");
  return JSON.parse(String(push.init!.body));
}

const ACCEPTED = {
  MerchantRequestID: "29115-34620561-1",
  CheckoutRequestID: "ws_CO_191220191020363925",
  ResponseCode: "0",
  ResponseDescription: "Success. Request accepted for processing",
  CustomerMessage: "Success. Request accepted for processing",
};

const REQUEST = {
  reference: "MM-0123456789ABCDEFGH", // deliberately longer than Daraja allows
  amountMinor: 50_000, // KES 500.00
  currency: "KES",
  msisdn: TEST_MSISDN,
  country: "KE",
  dialCode: "254",
  narrative: "School fees for the second term",
  callbackUrl: "https://school.example/payments/mobile-money/callback/mpesa",
};

describe("STK push — the request Safaricom will receive", () => {
  const realFetch = global.fetch;
  let provider: MpesaProvider;
  let calls: Call[];
  let body: Record<string, unknown>;

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    delete process.env.MPESA_ENV;
    provider = new MpesaProvider();
    calls = stubFetch(ACCEPTED);
    await provider.charge(REQUEST);
    body = stkBody(calls);
  });
  afterAll(() => {
    global.fetch = realFetch;
    for (const k of Object.keys(ENV)) delete process.env[k as keyof typeof ENV];
  });

  it("goes to the SANDBOX unless production is asked for by name", () => {
    // A misconfigured deploy must fail closed onto the sandbox. Defaulting the
    // other way means a typo in one env var charges real parents real money.
    expect(calls.every((c) => c.url.startsWith("https://sandbox.safaricom.co.ke"))).toBe(true);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/oauth/v1/generate",
      "/mpesa/stkpush/v1/processrequest",
    ]);
  });

  it("authenticates with Basic key:secret, then bearers the returned token", () => {
    const auth = (calls[0].init!.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${Buffer.from("ck_test:cs_test").toString("base64")}`);
    expect(new URL(calls[0].url).searchParams.get("grant_type")).toBe("client_credentials");
    expect((calls[1].init!.headers as Record<string, string>).Authorization).toBe("Bearer tok_123");
  });

  it("derives Password from the SAME timestamp it sends", () => {
    // THE classic Daraja 401. Password is base64(shortcode + passkey + timestamp);
    // compute it from a second `new Date()` and it disagrees with Timestamp
    // whenever the two land either side of a tick — a failure that appears roughly
    // once in a thousand charges and is near-impossible to reproduce by hand.
    expect(String(body.Timestamp)).toMatch(/^\d{14}$/);
    expect(Buffer.from(String(body.Password), "base64").toString("utf8")).toBe(
      `${ENV.MPESA_SHORTCODE}${ENV.MPESA_PASSKEY}${body.Timestamp}`,
    );
  });

  it("sends a WHOLE-number Amount in major units", () => {
    // Daraja rejects a decimal Amount. 50,000 minor KES is 500 shillings.
    expect(body.Amount).toBe(500);
    expect(Number.isInteger(body.Amount)).toBe(true);
  });

  it("puts the payer's MSISDN in both fields Daraja reads it from", () => {
    expect(body.PhoneNumber).toBe(TEST_MSISDN);
    expect(body.PartyA).toBe(TEST_MSISDN);
    expect(body.PartyB).toBe(ENV.MPESA_SHORTCODE);
    expect(body.BusinessShortCode).toBe(ENV.MPESA_SHORTCODE);
    expect(body.TransactionType).toBe("CustomerPayBillOnline");
  });

  it("truncates to Daraja's field limits rather than being rejected by them", () => {
    // Over-length values are refused outright, so the truncation is deliberate.
    expect(String(body.AccountReference).length).toBeLessThanOrEqual(12);
    expect(String(body.TransactionDesc).length).toBeLessThanOrEqual(13);
    expect(String(REQUEST.reference).startsWith(String(body.AccountReference))).toBe(true);
  });

  it("sends the callback URL the rail must answer on", () => {
    expect(body.CallBackURL).toBe(REQUEST.callbackUrl);
  });
});

describe("STK push — refusals", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    Object.assign(process.env, ENV);
    delete process.env.MPESA_ENV;
  });
  afterEach(() => {
    global.fetch = realFetch;
    for (const k of Object.keys(ENV)) delete process.env[k as keyof typeof ENV];
  });

  it("treats a 200 carrying a non-zero ResponseCode as a FAILURE", () => {
    // Daraja answers 200 with an error body. Trusting the HTTP status alone would
    // report a charge as sent that never reached the payer's handset.
    stubFetch({ ResponseCode: "1", errorMessage: "Invalid PhoneNumber" });
    return expect(new MpesaProvider().charge(REQUEST)).rejects.toThrow(/Invalid PhoneNumber/);
  });

  it("refuses a fractional amount rather than rounding it onto the payer", () => {
    stubFetch(ACCEPTED);
    return expect(
      new MpesaProvider().charge({ ...REQUEST, amountMinor: 50_050 }), // KES 500.50
    ).rejects.toThrow(/whole shillings/);
  });

  it("is DISABLED, not half-working, without credentials", () => {
    for (const k of Object.keys(ENV)) delete process.env[k as keyof typeof ENV];
    const p = new MpesaProvider();
    expect(p.isConfigured()).toBe(false);
    return expect(p.charge(REQUEST)).rejects.toThrow(/not configured/);
  });

  it("goes to production ONLY on the exact string 'production'", () => {
    process.env.MPESA_ENV = "prod"; // a plausible near-miss
    const calls = stubFetch(ACCEPTED);
    return new MpesaProvider().charge(REQUEST).then(() => {
      expect(calls.every((c) => c.url.includes("sandbox"))).toBe(true);
    });
  });
});

describe("callback — Safaricom's REAL body, not one we invented", () => {
  const provider = new MpesaProvider();

  // Verbatim from the Daraja documentation.
  const SUCCESS = {
    Body: {
      stkCallback: {
        MerchantRequestID: "29115-34620561-1",
        CheckoutRequestID: "ws_CO_191220191020363925",
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: 1.0 },
            { Name: "MpesaReceiptNumber", Value: "NLJ7RT61SV" },
            { Name: "TransactionDate", Value: 20191219102115 },
            { Name: "PhoneNumber", Value: 254708374149 },
          ],
        },
      },
    },
  };

  const CANCELLED = {
    Body: {
      stkCallback: {
        MerchantRequestID: "29115-34620561-1",
        CheckoutRequestID: "ws_CO_191220191020363925",
        ResultCode: 1032,
        ResultDesc: "Request cancelled by user",
      },
    },
  };

  it("recovers the charge from CheckoutRequestID — the only id Daraja returns", () => {
    // The defect this test was written to catch. Note the success body above: there
    // is NO AccountReference in it. Matching on one drops every real payment.
    expect(SUCCESS.Body.stkCallback.CallbackMetadata.Item.some((i) => i.Name === "AccountReference")).toBe(false);

    const r = provider.readCallback(SUCCESS);
    expect(r.providerRef).toBe("ws_CO_191220191020363925");
    expect(r.outcome).toBe("SUCCEEDED");
  });

  it("reads a cancelled payment as FAILED, with Safaricom's own words", () => {
    const r = provider.readCallback(CANCELLED);
    expect(r.outcome).toBe("FAILED");
    expect(r.failureReason).toBe("Request cancelled by user");
    expect(r.providerRef).toBe("ws_CO_191220191020363925"); // still matchable
  });

  it("never reads an AMOUNT from the callback", () => {
    // The callback is unsigned: anyone who learns the URL can post one. The amount
    // in it is therefore not evidence. This asserts the reading carries no amount
    // field at all, so no later change can start trusting it by accident.
    expect(Object.keys(provider.readCallback(SUCCESS))).toEqual(
      expect.not.arrayContaining(["amount", "amountMinor"]),
    );
  });

  it("holds a payload it cannot parse at PENDING rather than guessing", () => {
    for (const junk of [{}, { Body: {} }, null, "not json", { Body: { stkCallback: {} } }]) {
      expect(provider.readCallback(junk).outcome).toBe("PENDING");
    }
  });
});

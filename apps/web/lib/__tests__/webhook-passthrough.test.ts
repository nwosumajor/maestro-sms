/**
 * @jest-environment node
 */
// =============================================================================
// The webhook passthrough — the two ways it would silently stop working
// =============================================================================
// Gateway callbacks had no route from the internet in any environment. This
// route is that path, and it has exactly two properties that matter:
//
//   1. RAW BYTES survive. Paystack HMACs the raw body; Stripe HMACs
//      `${t}.${rawBody}`. Re-serialising identical-looking JSON changes the
//      bytes and every signature fails — a failure that looks like "the gateway
//      is sending bad signatures", not like a proxy bug.
//   2. The SIGNATURE HEADER travels. Dropping it turns a verified webhook into
//      an unauthenticated one, which the API correctly rejects. The pre-existing
//      /api/public proxy forwarded Content-Type and nothing else, which is
//      exactly how this would be reintroduced.
//
// Both are asserted against the real handler with fetch stubbed, because a test
// that mocks the handler would prove nothing about either.
// =============================================================================

import { POST, PUT } from "../../app/api/webhooks/[...path]/route";

type Captured = { url: string; init: RequestInit };

function stubFetch(): { calls: Captured[] } {
  const calls: Captured[] = [];
  global.fetch = jest.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as never;
  return { calls };
}

const req = (body: string, headers: Record<string, string>) =>
  new Request("http://localhost/api/webhooks/paystack", { method: "POST", body, headers }) as never;

describe("webhook passthrough", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("forwards the RAW body byte-for-byte", async () => {
    const { calls } = stubFetch();
    // Deliberately awkward: key order and spacing that JSON.parse/stringify
    // would silently normalise, which is what breaks the HMAC.
    const raw = '{"event":"charge.success",  "data":{"amount":100000,"reference":"PAY-1"}}';
    await POST(req(raw, { "content-type": "application/json", "x-paystack-signature": "sig" }), {
      params: { path: ["paystack"] },
    });
    expect(Buffer.from(calls[0].init.body as Buffer).toString("utf8")).toBe(raw);
  });

  it("forwards the SIGNATURE header", async () => {
    const { calls } = stubFetch();
    await POST(req("{}", { "content-type": "application/json", "x-paystack-signature": "abc123" }), {
      params: { path: ["paystack"] },
    });
    expect((calls[0].init.headers as Record<string, string>)["x-paystack-signature"]).toBe("abc123");
  });

  it("routes each provider to its own verifying endpoint", async () => {
    const { calls } = stubFetch();
    await POST(req("{}", {}), { params: { path: ["paystack"] } });
    await POST(req("{}", {}), { params: { path: ["stripe"] } });
    await PUT(req("{}", {}), { params: { path: ["mobile-money", "mtn"] } });
    // These are the controllers' REAL routes, prefix included. Two of them were
    // wrong here and in the passthrough — Stripe's handler lives under the
    // `billing` controller and mobile money's under `payments/mobile-money` —
    // and this test pinned the wrong values rather than catching them, because
    // it was written from the same assumption as the code.
    // api/test/payments/webhook-targets.spec.ts now derives them from the
    // controllers instead, so the two cannot agree with each other and both be
    // wrong.
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/payments/webhook",
      "/billing/stripe/webhook",
      "/payments/mobile-money/callback/mtn",
    ]);
  });

  it("is an ALLOWLIST — it cannot be used to reach the rest of the API", async () => {
    const { calls } = stubFetch();
    for (const path of [["admin"], ["paystack", "extra"], ["../invoices"], ["mobile-money", "../../users"]]) {
      const res = await POST(req("{}", {}), { params: { path } });
      expect(res.status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it("answers 502 when the API is unreachable, so the gateway RETRIES", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as never;
    const res = await POST(req("{}", {}), { params: { path: ["paystack"] } });
    // The one case where a non-2xx is right: the alternative is a payment
    // confirmed by nothing until the nightly reconciliation sweep.
    expect(res.status).toBe(502);
  });
});

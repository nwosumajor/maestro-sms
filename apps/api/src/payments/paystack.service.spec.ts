import { PaystackService } from "./paystack.service";

describe("PaystackService.refund", () => {
  const service = new PaystackService();
  const realFetch = global.fetch;

  afterEach(() => {
    delete process.env.PAYSTACK_SECRET_KEY;
    global.fetch = realFetch;
  });

  it("is a safe no-op ({ok:false}) when the gateway is not configured", async () => {
    const res = await service.refund({ transactionReference: "PAY-x", amountMinor: 5000 });
    expect(res.ok).toBe(false);
  });

  it("posts the original transaction reference + amount (money can only return to the paying card)", async () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_test";
    let captured: { url: string; init: RequestInit } | null = null;
    global.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

    const res = await service.refund({ transactionReference: "PAY-abc123", amountMinor: 300000 });
    expect(res.ok).toBe(true);
    expect(captured!.url).toBe("https://api.paystack.co/refund");
    expect(JSON.parse(String(captured!.init.body))).toEqual({ transaction: "PAY-abc123", amount: 300000 });
  });

  it("reports provider errors without throwing (caller falls back to manual return)", async () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_test";
    global.fetch = (async () => ({ ok: false, status: 400 }) as Response) as unknown as typeof fetch;
    expect((await service.refund({ transactionReference: "PAY-x", amountMinor: 100 })).ok).toBe(false);
    global.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await service.refund({ transactionReference: "PAY-x", amountMinor: 100 })).ok).toBe(false);
  });
});

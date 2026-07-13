import crypto from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { StripeService } from "./stripe.service";

function sign(body: string, secret: string, t: number): string {
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("StripeService.verifyWebhook", () => {
  const secret = "whsec_test_secret";
  const service = new StripeService();
  const body = JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { client_reference_id: "SUB-x", payment_status: "paid", metadata: { kind: "subscription" } } },
  });

  afterEach(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("returns null when the gateway is disabled (no secret)", () => {
    expect(service.verifyWebhook(Buffer.from(body), "t=1,v1=abc")).toBeNull();
  });

  it("accepts a correctly signed, fresh payload", () => {
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    const t = Math.floor(Date.now() / 1000);
    const event = service.verifyWebhook(Buffer.from(body), sign(body, secret, t));
    expect(event?.type).toBe("checkout.session.completed");
    expect(event?.data.object.client_reference_id).toBe("SUB-x");
  });

  it("rejects a tampered payload", () => {
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    const t = Math.floor(Date.now() / 1000);
    const sig = sign(body, secret, t);
    const tampered = body.replace("SUB-x", "SUB-y");
    expect(() => service.verifyWebhook(Buffer.from(tampered), sig)).toThrow(UnauthorizedException);
  });

  it("rejects a wrong-secret signature and a missing header", () => {
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    const t = Math.floor(Date.now() / 1000);
    expect(() => service.verifyWebhook(Buffer.from(body), sign(body, "whsec_other", t))).toThrow(
      UnauthorizedException,
    );
    expect(() => service.verifyWebhook(Buffer.from(body), undefined)).toThrow(UnauthorizedException);
  });

  it("rejects a stale timestamp (replay protection)", () => {
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect(() => service.verifyWebhook(Buffer.from(body), sign(body, secret, stale))).toThrow(
      UnauthorizedException,
    );
  });
});

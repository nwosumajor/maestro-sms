// =============================================================================
// The platform sold something and kept no record of the money
// =============================================================================
// Message-credit bundles are sold to schools through Paystack like any other
// platform charge. `applyPurchase` read the amount off the signed event,
// compared it to the bundle price so a short payment could never credit a
// bundle — and then wrote a ledger row carrying the CREDITS GRANTED and nothing
// at all about the money.
//
// Two consequences, both real:
//   • the operator's revenue ledger reads `platform_subscription_payment`,
//     which a bundle never touches, so this revenue line appeared on NO screen
//     in the product; and
//   • because the figure was never persisted, it could not be recovered from
//     our own database at all — only from the gateway's.
//
// The amount was in hand, checked, and discarded on the next line.
// =============================================================================

import { MESSAGE_CREDIT_BUNDLES } from "@sms/types";
import { MessageCreditsService } from "../../src/notifications/message-credits.service";

const BUNDLE = MESSAGE_CREDIT_BUNDLES[0];

function makeService() {
  const create = jest.fn().mockResolvedValue({});
  const svc = Object.create(MessageCreditsService.prototype) as MessageCreditsService;
  Object.assign(svc, {
    db: {
      runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) =>
        fn({ messageCreditEntry: { findFirst: jest.fn().mockResolvedValue(null), create } }),
      ),
    },
  });
  return { svc, create };
}

const event = (over: Record<string, unknown> = {}) =>
  ({
    event: "charge.success",
    data: {
      amount: BUNDLE.priceMinor,
      currency: "NGN",
      reference: "MC-1",
      metadata: { kind: "credits", schoolId: "s1", bundleId: BUNDLE.id },
      ...over,
    },
  }) as never;

describe("a message-credit purchase", () => {
  it("records WHAT WAS PAID, not only what was granted", async () => {
    const { svc, create } = makeService();
    await svc.applyPurchase(event());
    expect(create.mock.calls[0][0].data).toMatchObject({
      deltaCredits: BUNDLE.credits,
      amountMinor: BUNDLE.priceMinor,
      currency: "NGN",
      bundleId: BUNDLE.id,
      reason: "PURCHASE",
    });
  });

  it("records what the GATEWAY charged, not the list price", async () => {
    // The two are compared so a short payment cannot credit a bundle, but an
    // OVERpayment settles — and the books must say what actually arrived.
    const { svc, create } = makeService();
    await svc.applyPurchase(event({ amount: BUNDLE.priceMinor + 5_000 }));
    expect(create.mock.calls[0][0].data.amountMinor).toBe(BUNDLE.priceMinor + 5_000);
  });

  it("uppercases the currency at the boundary", async () => {
    // Stripe reports currency lower-case and the adapters normalise; this path
    // takes whatever the event carries, so it normalises here too.
    const { svc, create } = makeService();
    await svc.applyPurchase(event({ currency: "usd" }));
    expect(create.mock.calls[0][0].data.currency).toBe("USD");
  });

  it("still refuses to credit a bundle that was underpaid", async () => {
    // The control this change must not disturb.
    const { svc, create } = makeService();
    await svc.applyPurchase(event({ amount: BUNDLE.priceMinor - 1 }));
    expect(create).not.toHaveBeenCalled();
  });

  it("names the BUNDLE, because the credit count does not identify it", async () => {
    // Two bundles can grant the same number of credits at different prices. A
    // ledger line whose product is inferred is one nobody can audit.
    const { svc, create } = makeService();
    await svc.applyPurchase(event());
    expect(create.mock.calls[0][0].data.bundleId).toBe(BUNDLE.id);
  });
});

// =============================================================================
// Checkout intents — a PENDING row must mean money is actually in flight
// =============================================================================
// The payment row is written BEFORE the gateway is called, deliberately: an
// arriving webhook needs something to match, the same intent-first pattern as
// MobileMoneyIntent. Nothing undid it when the gateway then refused, and
// nothing ever expired one the school simply abandoned.
//
// So a school's payment history filled with rows saying PENDING — which reads
// as "your money is on its way" — for checkouts where nobody was ever charged.
// Eight of them accumulated on the demo tenant from a single afternoon of
// testing, two from charges the gateway had refused outright.
// =============================================================================

import { BillingDunningService } from "../../src/billing/billing-dunning.service";

describe("checkout intents", () => {
  afterEach(() => jest.restoreAllMocks());

  describe("abandonment sweep", () => {
    function makeSweep(updateMany = jest.fn().mockResolvedValue({ count: 3 })) {
      const svc = Object.create(BillingDunningService.prototype) as BillingDunningService;
      Object.assign(svc, { logger: { log: jest.fn(), warn: jest.fn() } });
      const client = { platformSubscriptionPayment: { updateMany } };
      const expire = (svc as unknown as {
        expireStaleIntents: (c: unknown) => Promise<number>;
      }).expireStaleIntents.bind(svc);
      return { expire, client, updateMany };
    }

    it("only ever touches PENDING rows", async () => {
      // A PAID row is the school's receipt. Nothing in this sweep may rewrite
      // one, however stale it looks.
      const { expire, client, updateMany } = makeSweep();
      await expire(client);
      expect(updateMany.mock.calls[0][0].where.status).toBe("PENDING");
      expect(updateMany.mock.calls[0][0].data.status).toBe("ABANDONED");
    });

    it("leaves recent intents alone — the cutoff is in the past", async () => {
      const { expire, client, updateMany } = makeSweep();
      const before = Date.now();
      await expire(client);
      const cutoff = updateMany.mock.calls[0][0].where.createdAt.lt as Date;
      expect(cutoff.getTime()).toBeLessThan(before);
      // Generous on purpose: marking a real payment abandoned is worse than
      // leaving a dead row visible a while longer.
      expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(24 * 3_600_000);
    });

    it("marks them ABANDONED, not FAILED", async () => {
      // Nothing went wrong and nobody was charged. Dressing a change of mind as
      // a failure invites a support call about a problem that does not exist.
      const { expire, client, updateMany } = makeSweep();
      await expire(client);
      expect(updateMany.mock.calls[0][0].data.status).not.toBe("FAILED");
    });

    it("reports how many it closed", async () => {
      const { expire, client } = makeSweep(jest.fn().mockResolvedValue({ count: 7 }));
      expect(await expire(client)).toBe(7);
    });

    it("never fails the whole dunning sweep over bookkeeping", async () => {
      // Chasing lapsed subscriptions matters more than tidying dead intents.
      const { expire, client } = makeSweep(jest.fn().mockRejectedValue(new Error("db down")));
      expect(await expire(client)).toBe(0);
    });
  });

  describe("voiding a refused checkout", () => {
    // Imported lazily so this file does not drag BillingService's whole DI
    // graph into the abandonment cases above.
    async function makeBilling(updateMany = jest.fn().mockResolvedValue({ count: 1 })) {
      const { BillingService } = await import("../../src/billing/billing.service");
      const svc = Object.create(BillingService.prototype) as InstanceType<typeof BillingService>;
      const tx = { platformSubscriptionPayment: { updateMany } };
      Object.assign(svc, {
        db: { runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx)) },
        logger: { warn: jest.fn(), log: jest.fn() },
      });
      const voidIntent = (svc as unknown as {
        voidIntent: (s: string, p: string, r: string) => Promise<void>;
      }).voidIntent.bind(svc);
      return { voidIntent, updateMany };
    }

    it("marks a refused checkout FAILED, and only if it is still PENDING", async () => {
      // The guard matters: a webhook can win the race and mark it PAID while
      // our own error path is still unwinding. That must not be overwritten.
      const { voidIntent, updateMany } = await makeBilling();
      await voidIntent("school-1", "pay-1", "Gateway refused: 403");
      expect(updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: "pay-1", status: "PENDING" },
        data: { status: "FAILED" },
      });
    });

    it("swallows its own errors — the real gateway error must survive", async () => {
      // The caller is already throwing something the school needs to see.
      const { voidIntent } = await makeBilling(jest.fn().mockRejectedValue(new Error("db down")));
      await expect(voidIntent("school-1", "pay-1", "boom")).resolves.toBeUndefined();
    });
  });
});

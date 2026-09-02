/**
 * A promo code's `maxUses` is a redemption BUDGET — money the platform owner
 * has decided to give away. It was checked at CHECKOUT against `usedCount`,
 * which is incremented at SETTLE, so between the two the code was unlocked.
 * That gap is not a millisecond race: it is however long a payer takes on the
 * gateway.
 *
 * MEASURED live on a school that had never paid, against a code with
 * `maxUses: 1`:
 *
 *     attempt 1   201   PENDING  NGN 100  promoCode PROBE-ONE
 *     attempt 2   201   PENDING  NGN 100  promoCode PROBE-ONE
 *     attempt 3   201   PENDING  NGN 100  promoCode PROBE-ONE
 *
 * Three live discounted charges from one school; across schools it is
 * unbounded.
 */
import { BadRequestException } from "@nestjs/common";
import { GrowthService } from "../../src/billing/growth.service";

function svc(promo: Record<string, unknown> | null, inFlight: number | Error) {
  const warnings: string[] = [];
  const s = Object.create(GrowthService.prototype) as GrowthService;
  Object.assign(s, {
    logger: { warn: (m: string) => warnings.push(m), log: () => {} },
    privileged: {
      client:
        inFlight instanceof Error
          ? {
              platformSubscriptionPayment: {
                count: async () => {
                  throw inFlight;
                },
              },
            }
          : inFlight < 0
            ? null
            : {
                platformSubscriptionPayment: {
                  // Honours the WHERE — a stub answering every query the same
                  // way would pass against a service that stopped filtering.
                  count: async ({ where }: { where: { promoCode: string; status: string } }) =>
                    where.promoCode === promo?.code && where.status === "PENDING" ? inFlight : 0,
                },
              },
    },
  });
  return { s, warnings };
}

// The global promo table is read through the app-role singleton.
jest.mock("@sms/db", () => ({
  prisma: { promoCode: { findFirst: async () => (global as never as { __promo: unknown }).__promo } },
  Prisma: {},
}));

const setPromo = (p: Record<string, unknown> | null) => {
  (global as never as { __promo: unknown }).__promo = p;
};

const PROMO = { code: "SPRING50", percentOff: 50, active: true, expiresAt: null, maxUses: 1, usedCount: 0 };

describe("a budget that counts what is in flight", () => {
  it("accepts the first checkout", async () => {
    setPromo({ ...PROMO });
    const { s } = svc(PROMO, 0);
    await expect(s.validatePromo("spring50")).resolves.toEqual({ code: "SPRING50", percentOff: 50 });
  });

  // THE DEFECT. One use of budget, one checkout already in flight, and the
  // second was accepted because nothing had settled yet.
  it("refuses once the budget is committed to checkouts in progress", async () => {
    setPromo({ ...PROMO });
    const { s } = svc(PROMO, 1);
    await expect(s.validatePromo("SPRING50")).rejects.toThrow(BadRequestException);
  });

  // TWO DIFFERENT SENTENCES, because they need different actions: a code that
  // is spent is spent, and a code that is merely committed may free up when an
  // abandoned checkout is swept.
  it("says which of the two it is", async () => {
    setPromo({ ...PROMO });
    const committed = svc(PROMO, 1);
    await expect(committed.s.validatePromo("SPRING50")).rejects.toThrow(/checkout in progress/);

    setPromo({ ...PROMO, usedCount: 1 });
    const spent = svc({ ...PROMO, usedCount: 1 }, 0);
    await expect(spent.s.validatePromo("SPRING50")).rejects.toThrow(/fully redeemed/);
  });

  // NO SECOND COUNTER OF ONE FACT: `usedCount` is what settled, the PENDING
  // rows are what is in flight, and the budget is the sum.
  it("adds the settled and the in-flight rather than counting either twice", async () => {
    setPromo({ ...PROMO, maxUses: 3, usedCount: 2 });
    const under = svc({ ...PROMO, maxUses: 3, usedCount: 2 }, 0);
    await expect(under.s.validatePromo("SPRING50")).resolves.toBeDefined();

    setPromo({ ...PROMO, maxUses: 3, usedCount: 2 });
    const at = svc({ ...PROMO, maxUses: 3, usedCount: 2 }, 1);
    await expect(at.s.validatePromo("SPRING50")).rejects.toThrow();
  });

  // AN UNLIMITED CODE MUST NOT PAY FOR THE COUNT.
  it("does not count in flight when there is no budget to bound", async () => {
    setPromo({ ...PROMO, maxUses: null });
    let counted = false;
    const s = Object.create(GrowthService.prototype) as GrowthService;
    Object.assign(s, {
      logger: { warn: () => {} },
      privileged: {
        client: {
          platformSubscriptionPayment: {
            count: async () => {
              counted = true;
              return 99;
            },
          },
        },
      },
    });
    await expect(s.validatePromo("SPRING50")).resolves.toBeDefined();
    expect(counted).toBe(false);
  });

  // FALLS BACK TO ZERO rather than refusing every promo checkout because a
  // database URL is unset — and says which happened.
  it.each([
    ["no privileged client", -1],
    ["a failed count", new Error("boom")],
  ])("degrades to the old behaviour on %s, loudly", async (_label, inFlight) => {
    setPromo({ ...PROMO });
    const { s, warnings } = svc(PROMO, inFlight as number | Error);
    await expect(s.validatePromo("SPRING50")).resolves.toBeDefined();
    expect(warnings.join(" ")).toMatch(/SPRING50/);
  });

  // The checks that already worked, so the fix cannot trade them away.
  it.each([
    ["an unknown code", null],
    ["an inactive code", { ...PROMO, active: false }],
    ["an expired code", { ...PROMO, expiresAt: new Date(Date.now() - 1000) }],
  ])("still refuses %s", async (_label, p) => {
    setPromo(p);
    const { s } = svc(p, 0);
    await expect(s.validatePromo("SPRING50")).rejects.toThrow(BadRequestException);
  });
});

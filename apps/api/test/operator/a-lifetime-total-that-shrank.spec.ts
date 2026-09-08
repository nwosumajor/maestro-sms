// =============================================================================
// "Revenue · all time" must mean all time
// =============================================================================
// The headline read the most recent 5,000 payment rows and summed them in Node.
// The bound was added deliberately — "the unbounded version grew with the
// platform's whole lifetime" — and it is the right instinct applied to the
// wrong half: what must not grow is the number of rows crossing the WIRE, not
// the number of rows COUNTED. An aggregate counts every row and returns one.
//
// Because the window is newest-first, older payments FALL OUT as new ones
// arrive. So a lifetime revenue figure went DOWN over time, silently, on a card
// labelled "all time". Measured on a 500-school fleet at 6,508 paid payments:
// the card read NGN 5,000,000.00 against a true NGN 30,846,756.64 — missing
// 83.8% — and nothing in the response or on the screen said a row had been left
// out. At 21,508 payments it now matches the database exactly, in 358 ms.
//
// The same capped array fed the monthly revenue TREND, so the historical bars
// of a growth chart shrank month by month: a chart of the platform's growth
// quietly erasing its own past.
//
// A capped newest-first list dropping the oldest rows is a class this codebase
// keeps meeting. A revenue total is the worst place for it, because the number
// stays plausible while being wrong.
// =============================================================================

import { PlatformAnalyticsService } from "../../src/operator/platform-analytics.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const owner: Principal = { schoolId: "platform", userId: "owner", roles: ["super_admin"], permissions: ["platform.operate"] };

/** Every PAID home-currency payment the "database" holds — far past any cap. */
const NGN_ROWS = 12_000;
const NGN_EACH = 250_000;
const TRUE_NGN_TOTAL = NGN_ROWS * NGN_EACH;

function harness() {
  const now = Date.now();
  // Newest first, as the real query orders them.
  const allPayments = Array.from({ length: NGN_ROWS }, (_, i) => ({
    schoolId: "s1",
    plan: "STANDARD",
    amountMinor: NGN_EACH,
    currency: "NGN",
    status: "PAID",
    createdAt: new Date(now - i * 60_000),
  }));

  const client = {
    school: {
      findMany: jest.fn().mockResolvedValue([{ id: "s1", name: "A School", status: "ACTIVE", createdAt: new Date(now) }]),
    },
    schoolSubscription: {
      findMany: jest.fn().mockResolvedValue([
        { schoolId: "s1", plan: "STANDARD", status: "ACTIVE", currency: "NGN", currentPeriodEnd: new Date(now + 86_400_000), graceDays: null, seats: 10, overrides: {} },
      ]),
    },
    platformSubscriptionPayment: {
      // HONOURS `take`. A stub that ignores it passes against a service that
      // went back to summing a capped page — the fixture trap this repo records
      // over and over.
      findMany: jest.fn(async ({ take }: { take?: number } = {}) =>
        typeof take === "number" ? allPayments.slice(0, take) : allPayments,
      ),
    },
    studentProfile: { findMany: jest.fn().mockResolvedValue([]) },
    onboardingRequest: { groupBy: jest.fn().mockResolvedValue([]) },
    // The aggregates. Shaped like the real rows Postgres returns, BigInt included
    // — SUM over int8 comes back as BigInt and JSON.stringify throws on one.
    $queryRaw: jest.fn(async (q: { strings?: string[]; sql?: string }) => {
      const text = (q?.strings ?? []).join(" ") + (q?.sql ?? "");
      if (/date_trunc\('month', "createdAt"\)[\s\S]*platform_subscription_payment/.test(text)) {
        return [{ month: new Date(now), total: BigInt(TRUE_NGN_TOTAL) }];
      }
      if (/platform_subscription_payment/.test(text)) {
        return [{ all_time: BigInt(TRUE_NGN_TOTAL), last30: BigInt(TRUE_NGN_TOTAL), n: NGN_ROWS }];
      }
      return [];
    }),
  };

  const svc = new PlatformAnalyticsService(
    { runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn({}) } as never,
    { record: jest.fn() } as never,
    { client } as never,
    { effectiveAll: jest.fn().mockResolvedValue({}) } as never,
  );
  return { svc, client };
}

describe("the all-time revenue figure", () => {
  it("counts EVERY payment, not the most recent page of them", async () => {
    const { svc } = harness();
    const out = await svc.overview(owner);
    expect(out.revenue.paidTotalMinor).toBe(TRUE_NGN_TOTAL);
  });

  it("does not pull the whole ledger over the wire to do it", async () => {
    // The other half of the rule: unbounded COUNTING, bounded FETCHING. The
    // preview needs ten rows and never needed five thousand.
    const { svc, client } = harness();
    await svc.overview(owner);
    for (const call of (client.platformSubscriptionPayment.findMany as jest.Mock).mock.calls) {
      expect(call[0]?.take ?? 0).toBeLessThanOrEqual(10);
    }
  });

  it("reports a COUNT that describes the same set as the total", async () => {
    // It was the length of a capped, all-currency array, so it agreed with the
    // money beside it about neither the currency nor the number of rows.
    const { svc } = harness();
    const out = await svc.overview(owner);
    expect(out.revenue.payments).toBe(NGN_ROWS);
  });

  it("says which currency the figure is in", async () => {
    const { svc } = harness();
    const out = await svc.overview(owner);
    expect(out.revenue.currency).toBe("NGN");
  });

  it("builds the revenue TREND from an aggregate, so history cannot shrink", async () => {
    const { svc } = harness();
    const out = await svc.overview(owner);
    const total = out.growth.reduce((n: number, b: { revenueMinor: number }) => n + b.revenueMinor, 0);
    expect(total).toBe(TRUE_NGN_TOTAL);
  });

  it("narrows BigInt sums to Number — JSON.stringify throws on a BigInt", async () => {
    const { svc } = harness();
    const out = await svc.overview(owner);
    expect(typeof out.revenue.paidTotalMinor).toBe("number");
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

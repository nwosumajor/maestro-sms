// =============================================================================
// 547 unpaid agent commissions that could not be reached, counted, or settled
// =============================================================================
// `listCommissions` is the ledger of money the PLATFORM OWES PEOPLE. It returned
// the newest 200 across the whole fleet, with no count, no page and no status
// filter — and `markCommissionPaid` takes an id obtainable from nowhere else.
//
// The ledger grows with the FLEET, not with one school: UNIQUE(schoolId) means
// one commission per attributed school, so at 1,000 agent-attributed schools
// there are 1,000 rows. Measured on that, with settlement independent of age:
//
//     unpaid            687 commissions, 22,081,500 minor owed
//     returned          200, of which 140 unpaid
//     owed visible      4,484,500 of 22,081,500
//     filter by status  none — the route took no parameters at all
//
// So 547 unpaid commissions, and the agents behind them, were unreachable — and
// unpayable, because the only id that marks one settled comes from this list.
//
// `owed` is grouped over the WHOLE ledger and is deliberately NOT narrowed by
// the filter or the page: "who do we still owe" must not be answered from
// whatever fits on screen. Per currency, because a commission carries its own.
// =============================================================================

import { GrowthService } from "../../src/billing/growth.service";

const COMMISSIONS = Array.from({ length: 1000 }, (_, i) => ({
  id: `c-${String(i).padStart(4, "0")}`,
  agentId: `a-${i % 5}`,
  agent: { name: `Agent ${i % 5}`, code: `AG${i % 5}` },
  schoolId: `s-${i}`,
  paymentRef: `REF-${i}`,
  amountMinor: 25_000 + (i % 30) * 500,
  // Settlement independent of age — the neutral assumption. Making the OLD ones
  // unpaid would have produced a more dramatic number from a less defensible
  // fixture.
  currency: i % 50 === 0 ? "USD" : "NGN",
  status: i % 10 < 7 ? "ACCRUED" : "PAID_OUT",
  paidOutAt: i % 10 < 7 ? null : new Date(),
  createdAt: new Date(Date.now() - (1000 - i) * 86_400_000),
}));

function makeService(rows = COMMISSIONS) {
  const match = (where: Record<string, unknown> = {}) =>
    rows.filter((r) => (where.status ? r.status === where.status : true));
  const client = {
    agentCommission: {
      findMany: jest.fn(async ({ where, take, skip }: Record<string, never>) => {
        const out = [...match(where)].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1),
        );
        const from = (skip as number) ?? 0;
        return out.slice(from, from + ((take as number) ?? out.length));
      }),
      count: jest.fn(async ({ where }: Record<string, never>) => match(where).length),
      // Grouped over whatever predicate it is GIVEN, so a service grouping the
      // wrong set is caught rather than vouched for.
      groupBy: jest.fn(async ({ where }: Record<string, never>) => {
        const by = new Map<string, { amount: number; n: number }>();
        for (const r of match(where)) {
          const e = by.get(r.currency) ?? { amount: 0, n: 0 };
          e.amount += r.amountMinor;
          e.n += 1;
          by.set(r.currency, e);
        }
        return [...by].map(([currency, v]) => ({
          currency,
          _sum: { amountMinor: v.amount },
          _count: { _all: v.n },
        }));
      }),
    },
    school: { findMany: jest.fn(async () => []) },
  };
  const svc = Object.create(GrowthService.prototype) as GrowthService;
  Object.assign(svc, { privileged: { client }, client: () => client });
  return { svc, client };
}

const UNPAID = COMMISSIONS.filter((c) => c.status === "ACCRUED");

describe("the ledger of what the platform owes its agents", () => {
  it("SAYS how many commissions there are, not how many fit the page", async () => {
    const { svc } = makeService();
    const r = await svc.listCommissions();
    expect(r.items.length).toBeLessThan(1000);
    expect(r.total).toBe(1000);
    expect(r.shown).toBe(r.items.length);
  });

  it("totals what is STILL OWED over the whole ledger, not the page", async () => {
    const { svc } = makeService();
    const r = await svc.listCommissions();
    const ngn = r.owed.find((o) => o.currency === "NGN");
    const expected = UNPAID.filter((c) => c.currency === "NGN").reduce((n, c) => n + c.amountMinor, 0);
    expect(ngn?.amountMinor).toBe(expected);
    expect(r.owed.reduce((n, o) => n + o.count, 0)).toBe(UNPAID.length);
  });

  it("NEVER adds one currency to another", async () => {
    const { svc } = makeService();
    const r = await svc.listCommissions();
    expect(r.owed.map((o) => o.currency).sort()).toEqual(["NGN", "USD"]);
  });

  it("counts only what is ACCRUED as owed — a paid one is not a debt", async () => {
    const { svc } = makeService();
    const r = await svc.listCommissions();
    const owedCount = r.owed.reduce((n, o) => n + o.count, 0);
    expect(owedCount).toBe(UNPAID.length);
    expect(owedCount).toBeLessThan(1000);
  });

  it("can ASK who is still owed — the filter that did not exist", async () => {
    const { svc } = makeService();
    const r = await svc.listCommissions({ status: "ACCRUED" });
    expect(r.total).toBe(UNPAID.length);
    expect(r.items.every((c) => c.status === "ACCRUED")).toBe(true);
  });

  it("keeps the OWED figure whole when the list is filtered", async () => {
    // Filtering to paid-out must not report that the platform owes nothing.
    const { svc } = makeService();
    const r = await svc.listCommissions({ status: "PAID_OUT" });
    expect(r.items.every((c) => c.status === "PAID_OUT")).toBe(true);
    expect(r.owed.reduce((n, o) => n + o.count, 0)).toBe(UNPAID.length);
  });

  it("reaches every commission by page — each id is the only way to settle one", async () => {
    const { svc } = makeService();
    const seen = new Set<string>();
    for (let page = 1; page <= 5; page += 1) {
      const r = await svc.listCommissions({ page });
      for (const c of r.items) seen.add(c.id);
    }
    expect(seen.size).toBe(1000);
  });

  it("a platform with no agents is unchanged and honest", async () => {
    const { svc } = makeService([]);
    const r = await svc.listCommissions();
    expect(r.total).toBe(0);
    expect(r.owed).toEqual([]);
  });
});

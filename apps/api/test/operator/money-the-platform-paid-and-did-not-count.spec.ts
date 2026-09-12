// =============================================================================
// 60 settlement releases, 50 returned, and a card that said "50 on record"
// =============================================================================
// `holding` answers "what the platform still owes this school, and what it has
// ALREADY PAID". The release history was `releasedAt DESC, take: 50` with no
// count, and the operator card then printed
//
//     {data.releases.length} release(s) on record
//
// straight off that array. Measured on a school five years into monthly
// settlement:
//
//     releases on record   60, 2021-11-07 .. 2026-09-12, 95,700,000 minor paid
//     returned             50
//     covered              2022-09-03 onward
//     money accounted for  80,150,000 of 95,700,000
//     card claimed         "50 release(s) on record"
//
// So ten months and 15,550,000 minor units of PLATFORM PAYMENTS were missing
// from the platform's own record of them, and the figure on screen looked like
// a fact. This is the same shape as the scholarship oversight panel, pointed at
// money the platform has actually transferred.
//
// The count and the per-currency totals are read separately now, so the card
// never describes the money from the page. PER CURRENCY for the same reason
// `held` is: a payment inherits its INVOICE's currency, this platform bills USD
// beside a school's local rail, and adding kobo to cents is forbidden.
// =============================================================================

import { SettlementReleaseService } from "../../src/operator/settlement-release.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const owner: Principal = {
  schoolId: "PLATFORM", userId: "owner", roles: ["super_admin"],
  permissions: ["platform.tenants.read", "platform.settlement.release"],
};
const SCHOOL = "school-a";

/** Five years of monthly releases, and a second currency alongside. */
const RELEASES = [
  ...Array.from({ length: 60 }, (_, i) => ({
    id: `rel-${String(i).padStart(3, "0")}`,
    schoolId: SCHOOL,
    amountMinor: 1_500_000 + (i % 20) * 10_000,
    currency: "NGN",
    paymentCount: 40,
    reference: `BANKREF-${i}`,
    note: null,
    releasedAt: new Date(Date.now() - (60 - i) * 30 * 86_400_000),
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `usd-${i}`,
    schoolId: SCHOOL,
    amountMinor: 120_000,
    currency: "USD",
    paymentCount: 3,
    reference: `USDREF-${i}`,
    note: null,
    releasedAt: new Date(Date.now() - (10 - i) * 30 * 86_400_000),
  })),
];

function makeService(rows = RELEASES) {
  const tx = {
    platformSettlementRelease: {
      findMany: jest.fn(async ({ take, skip }: Record<string, never>) => {
        const out = [...rows].sort(
          (a, b) => b.releasedAt.getTime() - a.releasedAt.getTime() || (a.id < b.id ? 1 : -1),
        );
        const from = (skip as number) ?? 0;
        return out.slice(from, from + ((take as number) ?? out.length));
      }),
      count: jest.fn(async () => rows.length),
      // Grouped over EVERY release, never the page — a double that honoured the
      // page's take here would vouch for totals describing only what was shown.
      groupBy: jest.fn(async () => {
        const by = new Map<string, { amount: number; n: number }>();
        for (const r of rows) {
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
    // Nothing currently held: this test is about what was PAID.
    payment: { findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;

  const svc = Object.create(SettlementReleaseService.prototype) as SettlementReleaseService;
  Object.assign(svc, {
    db: {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    },
    audit: { record: jest.fn() },
  });
  return { svc, tx };
}

describe("the platform's record of what it has paid a school", () => {
  it("COUNTS every release, not the ones that fit the page", async () => {
    const { svc } = makeService();
    const r = await svc.holding(owner, SCHOOL);
    expect(r.releases.length).toBeLessThan(64);
    expect(r.releaseTotal).toBe(64);
  });

  it("totals what was PAID over every release, not over the page", async () => {
    const { svc } = makeService();
    const r = await svc.holding(owner, SCHOOL);
    const ngn = r.releasedTotals.find((t) => t.currency === "NGN");
    // 60 releases: 1,500,000 each plus (i % 20) * 10,000.
    const expected = RELEASES.filter((x) => x.currency === "NGN").reduce((n, x) => n + x.amountMinor, 0);
    expect(ngn?.amountMinor).toBe(expected);
    expect(ngn?.paymentCount).toBe(60);
  });

  it("NEVER adds one currency to another", async () => {
    // A payment inherits its invoice's currency and this platform bills USD
    // beside a local rail, so a mixed history is ordinary.
    const { svc } = makeService();
    const r = await svc.holding(owner, SCHOOL);
    expect(r.releasedTotals.map((t) => t.currency).sort()).toEqual(["NGN", "USD"]);
    expect(r.releasedTotals.find((t) => t.currency === "USD")?.amountMinor).toBe(480_000);
  });

  it("reaches the older releases by page — the bank references an auditor needs", async () => {
    const { svc } = makeService();
    const first = await svc.holding(owner, SCHOOL);
    const older = await svc.holding(owner, SCHOOL, { page: 2 });
    expect(older.releases.length).toBeGreaterThan(0);
    expect(older.releases[0].id).not.toBe(first.releases[0].id);
    // The totals do not move with the page.
    expect(older.releaseTotal).toBe(first.releaseTotal);
  });

  it("a school never settled is unchanged and honest", async () => {
    const { svc } = makeService([]);
    const r = await svc.holding(owner, SCHOOL);
    expect(r.releaseTotal).toBe(0);
    expect(r.releasedTotals).toEqual([]);
    expect(r.releases).toEqual([]);
  });
});

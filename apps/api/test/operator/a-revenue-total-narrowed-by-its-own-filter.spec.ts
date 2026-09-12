// =============================================================================
// NGN 262,500,000 reported where NGN 420,000,000 had been paid
// =============================================================================
// `OperatorPaymentsService.totals` is careful, and says so:
//
//     "Totals for the WHOLE filter, split by currency — never just the page.
//      A finance screen whose totals describe only the visible 25 rows is worse
//      than no totals, because it looks authoritative."
//
// It is right. The FILTER was the thing that had been truncated. `schoolId` is a
// scalar with a database-level FK and no Prisma relation, so a name search has
// to materialise ids — and that lookup took the first 500 matching schools and
// fed them to a `schoolId IN`, which BOTH the list and the totals are computed
// from.
//
// Measured on a fleet where 800 schools share a name element ("St."), each with
// one paid subscription:
//
//     truth             800 payments, 420,000,000 minor
//     total reported    500
//     revenue reported  NGN 262,500,000
//
// 37.5% of the revenue missing from a finance screen, with nothing saying so —
// the exact failure the docstring one method below exists to prevent, defeated
// one layer above it. A guard on one door is not a guard.
// =============================================================================

import { OperatorPaymentsService } from "../../src/operator/operator-payments.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const owner: Principal = {
  schoolId: "PLATFORM", userId: "owner", roles: ["super_admin"],
  permissions: ["platform.revenue.read"],
};

/** 800 schools sharing a name element, one paid subscription each. */
const SCHOOLS = Array.from({ length: 800 }, (_, i) => ({
  id: `s-${String(i).padStart(4, "0")}`,
  name: `St. Probe ${i} College`,
}));
const PAYMENTS = SCHOOLS.map((s, i) => ({
  id: `p-${i}`,
  schoolId: s.id,
  plan: "STANDARD",
  billingCycle: "TERM",
  seats: 300,
  amountMinor: 525_000,
  currency: "NGN",
  status: "PAID",
  reference: `REF-${i}`,
  kind: "RENEWAL",
  initiatedById: "owner",
  paidAt: new Date(),
  createdAt: new Date(Date.now() - i * 3_600_000),
}));

function makeService() {
  const inIds = (where: Record<string, unknown>) =>
    (where.schoolId as { in?: string[] } | undefined)?.in;
  const match = (where: Record<string, unknown> = {}) => {
    const ids = inIds(where);
    return PAYMENTS.filter((p) => (ids ? ids.includes(p.schoolId) : true));
  };
  const client = {
    school: {
      // HONOURS the take: a double that returned every match would hide the
      // truncation this test exists for.
      findMany: jest.fn(async ({ where, take }: Record<string, never>) => {
        const needle = ((where as { name?: { contains?: string } })?.name?.contains ?? "").toLowerCase();
        const out = SCHOOLS.filter((s) => s.name.toLowerCase().includes(needle));
        return (take ? out.slice(0, take as number) : out).map((s) => ({ id: s.id, name: s.name }));
      }),
    },
    platformSubscriptionPayment: {
      findMany: jest.fn(async ({ where, take, skip }: Record<string, never>) => {
        const out = match(where);
        const from = (skip as number) ?? 0;
        return out.slice(from, from + ((take as number) ?? out.length));
      }),
      count: jest.fn(async ({ where }: Record<string, never>) => match(where).length),
      groupBy: jest.fn(async ({ where }: Record<string, never>) => {
        const rows = match(where);
        return [{
          currency: "NGN",
          status: "PAID",
          _sum: { amountMinor: rows.reduce((n, r) => n + r.amountMinor, 0) },
          _count: { _all: rows.length },
        }];
      }),
      aggregate: jest.fn(async () => ({ _sum: { amountMinor: 0 }, _count: { _all: 0 } })),
    },
    payment: { groupBy: jest.fn(async () => []), aggregate: jest.fn(async () => ({ _sum: {}, _count: { _all: 0 } })) },
    messageCreditEntry: { findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
    schoolSubscription: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => []) },
    // The page also reads fee revenue and seat arrears through raw SQL. A
    // double missing them fails as a CODE fault — "$queryRaw is not a function"
    // — rather than telling you anything about the filter under test.
    $queryRaw: jest.fn(async () => []),
  };

  const svc = Object.create(OperatorPaymentsService.prototype) as OperatorPaymentsService;
  Object.assign(svc, {
    privileged: { client },
    client: () => client,
    audit: { record: jest.fn() },
    record: jest.fn(),
  });
  return { svc, client };
}

describe("a revenue search across a fleet of similarly-named schools", () => {
  it("COUNTS every matching payment, not the first 500 schools' worth", async () => {
    const { svc } = makeService();
    const r = await svc.list(owner, { q: "St. Probe" } as never);
    expect(r.total).toBe(800);
  });

  it("reports the revenue that was actually PAID", async () => {
    // The defect as a number: NGN 262,500,000 of 420,000,000.
    const { svc } = makeService();
    const r = await svc.list(owner, { q: "St. Probe" } as never);
    const ngn = r.totals.find((t) => t.currency === "NGN");
    expect(ngn?.paidMinor).toBe(800 * 525_000);
  });

  it("says nothing was dropped when nothing was", async () => {
    // A flag that is always true is a banner nobody reads.
    const { svc } = makeService();
    const r = await svc.list(owner, { q: "St. Probe" } as never);
    expect(r.searchTruncated).toBe(false);
  });

  it("an empty match still returns NOTHING, not everything", async () => {
    // The rule the original comment got right, which must survive the fix: a
    // search matching no school must not silently widen to the whole platform.
    const { svc } = makeService();
    const r = await svc.list(owner, { q: "no-such-school" } as never);
    expect(r.total).toBe(0);
    expect(r.totals.every((t) => t.paidMinor === 0)).toBe(true);
  });

  it("an unfiltered read is unchanged", async () => {
    const { svc } = makeService();
    const r = await svc.list(owner, {} as never);
    expect(r.total).toBe(800);
    expect(r.searchTruncated).toBe(false);
  });
});

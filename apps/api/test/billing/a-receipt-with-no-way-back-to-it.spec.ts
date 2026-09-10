// =============================================================================
// The 51st payment, and the receipt nobody could reach
// =============================================================================
// The billing screen's payment history was `take: 50`, most recent first, with
// no page and no total — on the school's own record of what it has paid the
// platform. `platform_subscription_payment` is append-only by design, and a
// school adds more than one row a month: renewals, seat true-ups, add-on
// purchases, message credits.
//
// Measured on a fleet aged THREE YEARS: 48 rows per school. So every school on
// the platform crosses 50 in its FOURTH year, and from then on the oldest simply
// stop being there.
//
// What makes it worse than an ordinary truncation is where a payment's ID lives.
// The receipt route is `GET /billing/payments/:id/receipt.pdf`, and the ONLY
// place that id appears is this list. Driven at 90 payments:
//
//   the school has              90
//   the screen showed           50
//   unreachable                 40
//   a receipt for one of them, asked for directly -> 200, 1,675 bytes
//
// The record existed, the school was entitled to it, and there was no path to
// it. A school asked by its auditor for a receipt from two years ago could not
// produce one.
// =============================================================================

import { BillingService } from "../../src/billing/billing.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const bursar: Principal = {
  schoolId: "A",
  userId: "bursar",
  roles: ["school_admin"],
  permissions: ["billing.read"],
};

type Row = { id: string; reference: string; createdAt: Date; status: string };

/**
 * `held` payments, newest first.
 *
 * `tied` puts every row on ONE instant, which is what a batch of webhooks
 * settling together produces. It has to be total rather than merely frequent:
 * with five rows per second a page boundary only SOMETIMES lands inside a tie
 * group, so the test passed with the tiebreaker removed — by luck. A property
 * test that holds probabilistically holds for nothing.
 */
const history = (held: number, tied = false): Row[] =>
  Array.from({ length: held }, (_, i) => ({
    id: `pay-${String(i).padStart(3, "0")}`,
    reference: `REF-${String(i).padStart(3, "0")}`,
    createdAt: tied ? new Date(2026, 0, 1) : new Date(2026, 0, 1, 0, 0, i),
    status: "PAID",
  }));

function makeService(rows: Row[]) {
  const tx = {
    platformSubscriptionPayment: {
      findMany: jest.fn(async ({ skip = 0, take = 50, orderBy }: Record<string, never> & {
        skip?: number; take?: number; orderBy?: unknown;
      }) => {
        const out = [...rows];
        // Tied rows come back arbitrarily, as they do in Postgres. A double that
        // merely sorted would report a partial order as if it were total —
        // `Array.sort` is stable in V8 and the database is not.
        for (let i = out.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [out[i], out[j]] = [out[j], out[i]];
        }
        const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
        out.sort((a, b) => {
          for (const k of keys) {
            const [field, dir] = Object.entries(k ?? {})[0] ?? [];
            if (!field) continue;
            const av = String(a[field as keyof Row] ?? "");
            const bv = String(b[field as keyof Row] ?? "");
            if (av !== bv) return (av < bv ? -1 : 1) * (dir === "desc" ? -1 : 1);
          }
          return 0;
        });
        return out.slice(skip, skip + take);
      }),
      count: jest.fn(async () => rows.length),
    },
    schoolSubscription: { findFirst: jest.fn(async () => null) },
    user: { count: jest.fn(async () => 120) },
    userRole: { count: jest.fn(async () => 120) },
  } as unknown as TenantTx;

  const svc = new BillingService(
    {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    // entitlements
    {
      resolve: jest.fn(async () => ({ plan: "PREMIUM", modules: [] })),
      dtoFrom: jest.fn(() => ({ plan: "PREMIUM", status: "ACTIVE" })),
    } as never,
    { notify: jest.fn() } as never, // notifications
    { isConfigured: () => false } as never, // paystack
    { isConfigured: () => false } as never, // stripe
    { run: jest.fn() } as never, // dunning
    { effective: jest.fn(async () => ({})), effectiveAll: jest.fn(async () => ({})) } as never, // planPricing
    { quote: jest.fn() } as never, // addonPricing
    { grantRewardsInTx: jest.fn() } as never, // referrals
    { record: jest.fn() } as never, // growth
    { forSchool: jest.fn(async () => ({ currency: "NGN" })) } as never, // region
  );
  return { svc, tx };
}

describe("a school's record of what it paid the platform", () => {
  it("SAYS HOW MANY THERE ARE, so a page cannot read as the record", async () => {
    const { svc } = makeService(history(90));
    const out = await svc.getOverview(bursar);
    expect(out.paymentsTotal).toBe(90);
    expect(out.payments).toHaveLength(50);
    expect(out.paymentsPage).toBe(1);
  });

  it("lets the school reach the older ones — the 51st is on page two", async () => {
    const { svc } = makeService(history(90));
    const first = await svc.getOverview(bursar);
    const second = await svc.getOverview(bursar, { paymentsPage: 2 });
    expect(second.payments).toHaveLength(40);
    expect(second.paymentsPage).toBe(2);
    // Nothing seen twice, and nothing missed, across the whole record.
    const ids = new Set([...first.payments, ...second.payments].map((p) => p.id));
    expect(ids.size).toBe(90);
  });

  it("pages without losing a row, though payments share an instant", async () => {
    // A batch of webhooks settles within one second. Offset paging over a
    // partial order returns tied rows differently per page and silently skips
    // some — the same defect found in the gradebook, and free to prevent here.
    const { svc } = makeService(history(130, true));
    const seen = new Set<string>();
    for (let page = 1; page <= 3; page += 1) {
      const out = await svc.getOverview(bursar, { paymentsPage: page });
      out.payments.forEach((p) => seen.add(p.id));
    }
    expect(seen.size).toBe(130);
  });

  it("a school inside one page is unchanged", async () => {
    // Three years is 48 rows: most schools are still under the cap, and nothing
    // about their screen should move.
    const { svc } = makeService(history(48));
    const out = await svc.getOverview(bursar);
    expect(out.payments).toHaveLength(48);
    expect(out.paymentsTotal).toBe(48);
  });

  it("says nothing odd when the school has never paid", async () => {
    const { svc } = makeService([]);
    const out = await svc.getOverview(bursar);
    expect(out.payments).toEqual([]);
    expect(out.paymentsTotal).toBe(0);
    expect(out.paymentsPage).toBe(1);
  });

  it("counts in the DATABASE rather than measuring the page it fetched", async () => {
    const { svc, tx } = makeService(history(90));
    await svc.getOverview(bursar);
    expect((tx as unknown as { platformSubscriptionPayment: { count: jest.Mock } })
      .platformSubscriptionPayment.count).toHaveBeenCalled();
  });
});

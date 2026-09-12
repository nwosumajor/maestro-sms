// =============================================================================
// 901 payments awaiting a second signature, 200 visible, the oldest gone
// =============================================================================
// `listPendingPayments` is the maker-checker approver queue. A payment lands
// here when it is at or above the school's threshold, and ALL refunds do — and
// while it sits here it has NOT moved the invoice balance. The family has paid;
// the invoice still shows what they owe.
//
// It read `createdAt DESC, take: 200` with no count, under a docstring saying
// "ALL PENDING_APPROVAL payments in the tenant".
//
// Measured live on a five-year backlog of 901 pending payments:
//
//     pending in the DB   901, oldest 2021-10-09
//     returned            200
//     covered             2023-09-10 onward
//     money visible       53,630,000 of 242,370,000 minor units  (78% unseen)
//     said there was more nothing
//
// Newest-first on a queue hides exactly what a queue exists to surface: a
// pending row is pending BECAUSE nobody has dealt with it, so the backlog is
// bounded by what the school never got round to approving, and that grows. The
// families at the far end paid years ago.
//
// THE SIZE OF THIS QUEUE IS NOT HYPOTHETICAL. `effectivePaymentApprovalThreshold
// Minor` returns 0 for any school whose currency is not the platform's and which
// has not set a figure — the documented fail-safe where an unset control
// tightens. For those schools EVERY fee payment requires a second signature.
//
// A queue is worked OLDEST FIRST, which also makes the cap benign: what falls
// off the end is the most recent arrival, not the longest wait.
// =============================================================================

import { FeesService } from "../../src/fees/fees.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const approver: Principal = {
  schoolId: "A", userId: "head", roles: ["principal"],
  permissions: ["fee.approve", "fee.manage"],
};

/** Five years of unapproved payments, oldest first in index order. */
const PENDING = Array.from({ length: 901 }, (_, i) => ({
  id: `pay-${String(i).padStart(4, "0")}`,
  schoolId: "A",
  invoiceId: `inv-${i % 50}`,
  amountMinor: 250_000 + (i % 40) * 1_000,
  method: "CASH",
  reference: null,
  note: null,
  kind: "PAYMENT",
  status: "PENDING_APPROVAL",
  recordedById: "bursar",
  approvedById: null,
  paidAt: new Date(Date.now() - (901 - i) * 86_400_000),
  createdAt: new Date(Date.now() - (901 - i) * 86_400_000),
}));
/** Already-approved rows, which must never appear in the queue or its total. */
const POSTED = Array.from({ length: 300 }, (_, i) => ({
  ...PENDING[0], id: `posted-${i}`, status: "POSTED",
}));

function makeService(rows = [...PENDING, ...POSTED]) {
  const match = (where: Record<string, unknown> = {}) =>
    rows.filter((r) => (where.status ? r.status === where.status : true));
  const tx = {
    payment: {
      findMany: jest.fn(async ({ where, orderBy, take, skip }: Record<string, never>) => {
        const desc = JSON.stringify(orderBy ?? "").includes('"desc"');
        const out = [...match(where)].sort((a, b) =>
          desc
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
        const from = (skip as number) ?? 0;
        return out.slice(from, from + ((take as number) ?? out.length));
      }),
      count: jest.fn(async ({ where }: Record<string, never>) => match(where).length),
    },
  } as unknown as TenantTx;

  const svc = Object.create(FeesService.prototype) as FeesService;
  Object.assign(svc, {
    db: {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    },
  });
  return { svc, tx };
}

describe("the approver queue is worked from the front", () => {
  it("SAYS how much money is waiting, not how much fits the page", async () => {
    const { svc } = makeService();
    const r = await svc.listPendingPayments(approver);
    expect(r.items.length).toBeLessThan(901);
    expect(r.total).toBe(901);
    expect(r.shown).toBe(r.items.length);
  });

  it("shows the payments that have waited LONGEST first", async () => {
    // The property, not a date: page one is the front of the queue. Newest-first
    // is what buried the families who paid years ago.
    const { svc } = makeService();
    const r = await svc.listPendingPayments(approver);
    const ts = r.items.map((p) => new Date(p.createdAt).getTime());
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(ts[0]).toBe(PENDING[0].createdAt.getTime());
  });

  it("counts ONLY what is awaiting approval — never the approved rows", async () => {
    // A total that swept in POSTED payments would overstate the backlog and
    // send an approver looking for work that is already done.
    const { svc } = makeService();
    const r = await svc.listPendingPayments(approver);
    expect(r.total).toBe(901);
    // No already-approved row reaches the queue: the double holds 300 POSTED
    // payments and none of their ids may appear.
    expect(r.items.every((p) => !p.id.startsWith("posted-"))).toBe(true);
  });

  it("reaches the whole backlog by page, without repeating one", async () => {
    const { svc } = makeService();
    const seen = new Set<string>();
    for (let page = 1; page <= 5; page += 1) {
      const r = await svc.listPendingPayments(approver, { page });
      for (const p of r.items) seen.add(p.id);
    }
    expect(seen.size).toBe(901);
  });

  it("counts in the DATABASE, over the page's own predicate", async () => {
    const { svc, tx } = makeService();
    await svc.listPendingPayments(approver);
    const count = (tx as unknown as { payment: { count: jest.Mock } }).payment.count;
    expect(count).toHaveBeenCalled();
    expect(count.mock.calls[0][0].where).toMatchObject({ status: "PENDING_APPROVAL" });
  });

  it("a school with nothing waiting is unchanged", async () => {
    const { svc } = makeService(POSTED);
    const r = await svc.listPendingPayments(approver);
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
  });
});

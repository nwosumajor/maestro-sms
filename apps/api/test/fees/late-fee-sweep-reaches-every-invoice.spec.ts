// =============================================================================
// The cap must limit the WORK, not the candidates
// =============================================================================
// lateFeeSweep read `take: 500` overdue invoices and then skipped the ones that
// already carried the marker — in Node, after the fetch. So the cap was spent
// on invoices that were already done. Once a school had 500 marked invoices the
// sweep re-read the same 500 every night, applied nothing, and returned
// feesApplied: 0, which reads exactly like "nothing was overdue".
//
// Found live, not by reasoning: St. Andrews had 900 invoices overdue past its
// 7-day grace, 500 already marked and 400 not, and the sweep applied 0 in 633ms
// without a single warning. That school had silently stopped charging late fees
// for good. After the fix the same run applied 400 in 4.7s, left all 900
// marked, double-charged none, and a second run was a 195ms no-op.
//
// Two things had to change with it, or fixing the filter would have made
// matters worse:
//   - the sweep now does real work, and 400 invoices will not fit inside
//     Prisma's 5s interactive-transaction cap. One transaction per invoice: a
//     late fee is an independent fact, not part of one decision, so a failure
//     on the 400th must not undo the first 399.
//   - the guardian notice moved OUT of the write transaction. A notification
//     commits in its own transaction, so under the old shape a rolled-back run
//     still told every guardian their invoice had grown — nightly, for a charge
//     that never existed.
// =============================================================================

import { Logger } from "@nestjs/common";
import { FeeOpsService } from "../../src/fees/fee-ops.service";

type Inv = {
  id: string; totalMinor: number; studentId: string; reference: string;
  createdById: string; currency: string; dueDate: Date; marked: boolean;
};

const seen: { lastArgs?: { orderBy?: unknown; take?: number; where?: unknown } } = {};

/** Enough invoices to make the cap bite: N already marked, then some not. */
function invoices(markedCount: number, unmarkedCount: number): Inv[] {
  const out: Inv[] = [];
  for (let i = 0; i < markedCount + unmarkedCount; i++) {
    out.push({
      id: `inv-${i}`,
      totalMinor: 100_000,
      studentId: `stu-${i}`,
      reference: `INV-${i}`,
      createdById: "staff-1",
      currency: "NGN",
      // The MARKED ones are the oldest, so a query that does not exclude them
      // keeps handing them back ahead of the work that actually remains.
      dueDate: new Date(2026, 0, 1 + i),
      marked: i < markedCount,
    });
  }
  return out;
}

function build(rows: Inv[], opts: { failOn?: string } = {}) {
  const events: string[] = [];
  const created: string[] = [];
  const notified: string[] = [];

  const readTx = {
    invoice: {
      findMany: (args: { where: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
        events.push("query");
        seen.lastArgs = args;
        // The fake honours the filter the SERVICE asks for. If the service does
        // not ask to exclude marked invoices, the marked ones come back and eat
        // the cap — which is exactly the bug.
        const excludesMarked = JSON.stringify(args.where).includes("none");
        const rs = rows
          .filter((r) => !excludesMarked || !r.marked)
          .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
        return Promise.resolve(rs.slice(0, args.take ?? rs.length));
      },
    },
    parentChild: { findMany: () => Promise.resolve([{ parentId: "parent-1" }]) },
  };

  const db = {
    runAsTenantReadOnly: (_c: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(readTx),
    runAsTenant: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      events.push("tx:start");
      const tx = {
        invoiceLineItem: {
          findFirst: ({ where }: { where: { invoiceId: string } }) =>
            Promise.resolve(rows.find((r) => r.id === where.invoiceId)?.marked ? { id: "m" } : null),
          create: ({ data }: { data: { invoiceId: string } }) => {
            if (opts.failOn === data.invoiceId) throw new Error("boom");
            created.push(data.invoiceId);
            // The marker IS the idempotency guard, so the fake has to write it
            // — a stub that forgets makes a second run look like a double
            // charge that the real database would never allow.
            const row = rows.find((r) => r.id === data.invoiceId);
            if (row) row.marked = true;
            return Promise.resolve({});
          },
        },
        invoice: { update: () => Promise.resolve({}) },
      };
      try {
        const r = await fn(tx);
        events.push("tx:end");
        return r;
      } catch (e) {
        events.push("tx:rollback");
        throw e;
      }
    },
  };

  const svc = new FeeOpsService(
    db as never,
    { record: jest.fn() } as never,
    {
      enqueue: (_c: unknown, n: { data?: { invoiceId?: string } }) => {
        events.push("notify");
        notified.push(String(n.data?.invoiceId));
        return Promise.resolve({});
      },
    } as never,
    {
      client: {
        school: {
          findMany: () => Promise.resolve([{ id: "school-1", lateFeeFlatMinor: 5_000, lateFeeGraceDays: 7 }]),
        },
      },
    } as never,
    {} as never,
  );
  return { svc, events, created, notified };
}

describe("a school that has already been swept once", () => {
  beforeEach(() => { jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  it("still charges the invoices that have NOT been charged", async () => {
    // 500 marked — exactly the cap — and 5 that still need a late fee. Under
    // the old shape the cap was filled by the 500 and these 5 were invisible.
    const { svc, created } = build(invoices(500, 5));
    const r = await svc.lateFeeSweep();
    expect(r.feesApplied).toBe(5);
    expect(created).toEqual(["inv-500", "inv-501", "inv-502", "inv-503", "inv-504"]);
  });

  it("never charges an invoice twice", async () => {
    const { svc, created } = build(invoices(500, 5));
    const first = await svc.lateFeeSweep();
    const second = await svc.lateFeeSweep();
    expect(first.feesApplied).toBe(5);
    // The live run behaved exactly this way: 400 applied, then a 195ms no-op.
    expect(second.feesApplied).toBe(0);
    expect(new Set(created).size).toBe(created.length);
  });

  it("asks for the oldest overdue invoices first", async () => {
    const { svc } = build(invoices(0, 3));
    await svc.lateFeeSweep();
    expect(seen.lastArgs?.orderBy).toEqual({ dueDate: "asc" });
    expect(seen.lastArgs?.take).toBe(500);
  });
});

describe("the shape of the work", () => {
  beforeEach(() => { jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  it("commits each invoice on its own, so one failure costs one invoice", async () => {
    const { svc, created } = build(invoices(0, 4), { failOn: "inv-1" });
    const r = await svc.lateFeeSweep();
    expect(r.feesApplied).toBe(3);
    expect(created).toEqual(["inv-0", "inv-2", "inv-3"]);
  });

  it("tells the guardian only AFTER the fee is committed", async () => {
    const { svc, events } = build(invoices(0, 1));
    await svc.lateFeeSweep();
    // Inside the transaction a notice would land before tx:end — and would
    // survive a rollback, because it commits in a transaction of its own.
    expect(events).toEqual(["query", "tx:start", "tx:end", "notify"]);
  });

  it("sends NO notice for an invoice whose fee did not apply", async () => {
    const { svc, notified } = build(invoices(0, 2), { failOn: "inv-0" });
    await svc.lateFeeSweep();
    expect(notified).toEqual(["inv-1"]);
  });

  it("says so when it truncates instead of reporting a quiet night", async () => {
    const warned: string[] = [];
    jest.spyOn(Logger.prototype, "warn").mockImplementation((m: unknown) => { warned.push(String(m)); });
    const { svc } = build(invoices(0, 500));
    await svc.lateFeeSweep();
    expect(warned.join(" ")).toMatch(/hit its 500-invoice cap/);
  });
});

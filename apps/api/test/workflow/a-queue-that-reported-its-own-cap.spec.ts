// =============================================================================
// 666 waiting, 500 reported, and the oldest 166 unreachable
// =============================================================================
// The approvals queue (`GET /workflows?mine=1`) read the 500 most-recent
// PENDING_REVIEW rows and narrowed them in memory, on the reasoning that live
// work is "bounded by what the school is actually working on rather than by its
// history".
//
// Three years of data says otherwise. A request leaves PENDING_REVIEW only when
// somebody DECIDES it, and some never are — a leave request overtaken by events,
// a fee schedule nobody finished, a grade publish raised twice. The undecided
// pile up, so the live set is bounded by what the school has never got round to,
// which is not the same thing at all.
//
// Measured on a school in its fourth year with 666 pending, every one at this
// approver's stage:
//
//   the queue reported a total of                        500   (the cap)
//   pages walked, distinct rows reached                   20 / 500
//   awaiting them and unreachable at any page             166
//   one of the missing, asked for by id                   200
//
// They were the OLDEST — exactly the row a review queue exists to surface,
// because a pending row is pending precisely because nobody has dealt with it.
// The data was there and only the queue dropped it.
//
// It scans now: oldest-first, in batches, applying the SAME predicate the engine
// enforces rather than a second copy of the rule in SQL. `totalIsExact` says so
// when a scan does stop short, instead of handing back a cap dressed as a count.
// =============================================================================

import { WorkflowService } from "../../src/workflow/workflow.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const CHAIN = [
  { key: "HEAD", label: "Head teacher", permission: "workflow.review.head" },
  { key: "PRINCIPAL", label: "Principal (final)", permission: "workflow.review.principal" },
];

const head: Principal = {
  schoolId: "A",
  userId: "head",
  roles: ["head_teacher"],
  permissions: ["workflow.review", "workflow.review.head"],
};

type Row = {
  id: string;
  schoolId: string;
  type: string;
  title: string;
  payload: unknown;
  state: string;
  initiatorId: string;
  createdAt: Date;
  currentStage: number;
  stages: unknown;
  approvals: unknown;
};

/** `n` pending requests, oldest first, all at the head-teacher stage. */
const pending = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `req-${String(i).padStart(4, "0")}`,
    schoolId: "A",
    type: "LEAVE",
    title: `Leave ${String(i).padStart(4, "0")}`,
    payload: {},
    state: "PENDING_REVIEW",
    initiatorId: "teacher",
    // i = 0 is the OLDEST.
    createdAt: new Date(2023, 0, 1 + i),
    currentStage: 0,
    stages: CHAIN,
    approvals: [],
  }));

function makeService(rows: Row[]) {
  const tx = {
    workflowRequest: {
      findMany: jest.fn(async ({ where, orderBy, skip = 0, take = 25 }: {
        where?: Record<string, unknown>; orderBy?: unknown; skip?: number; take?: number;
      }) => {
        let out = rows.filter((r) => (where?.state ? r.state === where.state : true));
        // ORDERS THE WAY THE DATABASE DOES. Comparing `String(aDate)` sorts
        // "Sun Jan 01" against "Mon Jan 02" lexicographically, which is not an
        // order at all — the first version of this double reported the NEWEST
        // row at the top of an oldest-first query, and would have hidden a real
        // ordering defect just as readily as it invented one.
        const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
        const cmp = (a: Row, b: Row) => {
          for (const k of keys) {
            const [field, dir] = Object.entries(k ?? {})[0] ?? [];
            if (!field) continue;
            const av = a[field as keyof Row];
            const bv = b[field as keyof Row];
            const d =
              av instanceof Date && bv instanceof Date
                ? av.getTime() - bv.getTime()
                : String(av ?? "") < String(bv ?? "")
                  ? -1
                  : String(av ?? "") > String(bv ?? "")
                    ? 1
                    : 0;
            if (d !== 0) return d * (dir === "desc" ? -1 : 1);
          }
          return 0;
        };
        out = [...out].sort(cmp);
        return out.slice(skip, skip + take);
      }),
      count: jest.fn(async ({ where }: { where?: Record<string, unknown> }) =>
        rows.filter((r) => (where?.state ? r.state === where.state : true)).length,
      ),
    },
    user: { findMany: jest.fn(async () => []) },
    userRole: { findMany: jest.fn(async () => [{ userId: "head" }, { userId: "principal" }]) },
    role: { findMany: jest.fn(async () => []) },
    permission: { findFirst: jest.fn(async () => ({ id: "p1" })) },
  } as unknown as TenantTx;

  const svc = new WorkflowService(
    {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    { notify: jest.fn() } as never,
  );
  return { svc, tx };
}

describe("an approver's own queue", () => {
  it("REACHES EVERY REQUEST awaiting them, past the old cap of 500", async () => {
    const { svc } = makeService(pending(666));
    const seen = new Set<string>();
    let page = 1;
    let total = 0;
    for (;;) {
      const out = await svc.listRequests(head, { mine: true, page });
      total = out.total;
      out.items.forEach((i) => seen.add(i.id));
      if (page * out.pageSize >= out.total) break;
      page += 1;
      if (page > 60) break;
    }
    expect(total).toBe(666);
    expect(seen.size).toBe(666);
  });

  it("reports the COUNT, not the cap", async () => {
    const { svc } = makeService(pending(666));
    const out = await svc.listRequests(head, { mine: true });
    expect(out.total).toBe(666);
    expect(out.totalIsExact).toBe(true);
  });

  it("works OLDEST FIRST — the longest wait is the top of the queue", async () => {
    // The old order was newest-first, which is what made the cap drop the very
    // rows a queue exists to surface.
    const { svc } = makeService(pending(120));
    const out = await svc.listRequests(head, { mine: true });
    expect(out.items[0].title).toBe("Leave 0000");
    expect(out.items[out.items.length - 1].title).toBe("Leave 0024");
  });

  it("a school inside one batch is unchanged", async () => {
    const { svc } = makeService(pending(40));
    const out = await svc.listRequests(head, { mine: true });
    expect(out.total).toBe(40);
    expect(out.items).toHaveLength(25);
    expect(out.totalIsExact).toBe(true);
  });

  it("never counts a request this approver may not decide", async () => {
    // The predicate is the engine's own: their own request is not theirs to
    // approve, and neither is one waiting at a stage they do not hold.
    const rows = pending(10);
    rows[0].initiatorId = "head"; // raised by the approver
    rows[1].currentStage = 1; // waiting on the principal
    const { svc } = makeService(rows);
    const out = await svc.listRequests(head, { mine: true });
    expect(out.total).toBe(8);
    expect(out.items.map((i) => i.id)).not.toContain("req-0000");
    expect(out.items.map((i) => i.id)).not.toContain("req-0001");
  });

  it("says so when the scan stops short, rather than rounding down in silence", async () => {
    // A school with more undecided work than any queue can help with still gets
    // a truthful answer: the total is a FLOOR and the flag says which.
    const { svc } = makeService(pending(20_600));
    const out = await svc.listRequests(head, { mine: true });
    expect(out.totalIsExact).toBe(false);
    expect(out.total).toBeGreaterThanOrEqual(20_000);
  }, 30_000);

  it("leaves the HISTORY path alone — newest-first, paged in the database", async () => {
    const { svc, tx } = makeService(pending(666));
    const out = await svc.listRequests(head, { page: 2 });
    expect(out.total).toBe(666);
    expect(out.totalIsExact).toBe(true);
    const orders = (tx as unknown as { workflowRequest: { findMany: jest.Mock } })
      .workflowRequest.findMany.mock.calls.map((c) => JSON.stringify(c[0].orderBy));
    expect(orders.some((o) => o.includes('"desc"'))).toBe(true);
  });
});

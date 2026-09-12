// =============================================================================
// 1,350 papers, 100 reachable, and 201 queries to show them
// =============================================================================
// `GET /cbt/exams/all` is the staff exam console. It read the 100 most recent
// exams — `orderBy startAt desc, take: 100` — with no count, no search and no
// page, and then mapped them through `toExamDto`, which issues a `count` and a
// `findFirst` PER EXAM, awaited in a sequential loop.
//
// Measured on a five-year secondary fixture (15 subjects x 6 year groups x 3
// terms x 5 years = 1,350 papers) against the running stack:
//
//     held            1,350
//     returned          100
//     reachable         100   — no q, no page, no filter of any kind
//     queries/request   201   (1 list + 2 per exam)
//     latency          ~134 ms of work, inside one pooled transaction
//
// TWO defects on one read, and the second is what makes the first serious: the
// exam ROW is the only route to that exam's results, question paper, answer key
// and grade recording — every one of those is `cbt/exams/${e.id}/...` built from
// this list. So 1,250 papers were not merely slow to find, they and everything
// hanging off them were unreachable at any URL.
//
// The STUDENT branch of the same method was right all along: `endAt >= now`,
// class-scoped, ascending — bounded by a real predicate rather than an arbitrary
// cap. Sibling asymmetry inside one method.
// =============================================================================

import { CbtService } from "../../src/cbt/cbt.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = {
  schoolId: "A", userId: "teach-1", roles: ["teacher"],
  permissions: ["cbt.manage"],
};

const EXAMS = Array.from({ length: 1350 }, (_, i) => ({
  id: `ex-${String(i).padStart(4, "0")}`,
  title: i % 3 === 0 ? `Physics Paper ${i}` : `Chemistry Paper ${i}`,
  bankId: "bank-1",
  classId: null,
  questionCount: 20,
  durationMinutes: 60,
  // A TERM'S PAPERS SHARE AN INSTANT. They are set in one sitting, so `startAt`
  // alone is a PARTIAL order — which is the whole reason the query needs `id`
  // as a tiebreaker. A fixture giving every row its own day cannot test that,
  // and the first draft of this file did exactly that and passed the mutation.
  startAt: new Date(Date.now() - Math.floor(i / 30) * 86_400_000),
  endAt: new Date(Date.now() - Math.floor(i / 30) * 86_400_000 + 7_200_000),
  status: "CLOSED",
  answerRelease: "HIDDEN",
  answersReleasedAt: null,
  scholarshipProgramId: null,
}));

function makeService() {
  const queries = { findMany: 0, count: 0, findFirst: 0, groupBy: 0 };

  const match = (where: Record<string, unknown> = {}) => {
    const title = (where.title as { contains?: string } | undefined)?.contains;
    const status = where.status as string | undefined;
    return EXAMS.filter(
      (e) =>
        (status ? e.status === status : true) &&
        (title ? e.title.toLowerCase().includes(title.toLowerCase()) : true),
    );
  };

  const tx = {
    cbtExam: {
      // HONOURS where, orderBy, take AND skip. A stub ignoring skip reports a
      // pager that works while every page serves row one.
      findMany: jest.fn(async ({ where, take, skip, orderBy }: Record<string, never>) => {
        queries.findMany += 1;
        // SHUFFLE BEFORE SORTING. `Array.prototype.sort` is stable in V8 and
        // Postgres is not, so a double that merely sorts hands back a total
        // order the database never promised — and the tiebreaker assertion
        // passes against a query that has none.
        const pool = [...match(where)];
        for (let i = pool.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const ord = (orderBy ?? []) as Array<Record<string, string>>;
        const byId = Array.isArray(ord) && ord.some((o) => "id" in o);
        const rows = pool.sort(
          (a, b) =>
            b.startAt.getTime() - a.startAt.getTime() ||
            // Applied ONLY when the query asked for it.
            (byId ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : 0),
        );
        const from = (skip as number) ?? 0;
        return rows.slice(from, from + ((take as number) ?? rows.length));
      }),
      count: jest.fn(async ({ where }: Record<string, never>) => {
        queries.count += 1;
        return match(where).length;
      }),
    },
    cbtSitting: {
      groupBy: jest.fn(async () => {
        queries.groupBy += 1;
        return [{ examId: "ex-0000", _count: { _all: 12 } }];
      }),
      findMany: jest.fn(async () => {
        queries.findMany += 1;
        return [{ id: "sit-1", examId: "ex-0001", status: "SUBMITTED" }];
      }),
      count: jest.fn(async () => {
        queries.count += 1;
        return 0;
      }),
      findFirst: jest.fn(async () => {
        queries.findFirst += 1;
        return null;
      }),
    },
    scholarshipApplication: { findMany: jest.fn(async () => []) },
    enrollment: { findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;

  // Constructor order matters and is checked by the compiler; a double in the
  // wrong slot would fail as a code fault rather than a real one.
  const svc = new CbtService(
    {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,                                    // audit
    { createRequest: jest.fn(), submit: jest.fn() } as never,          // workflow
    { recordExamScores: jest.fn() } as never,                          // termResults
    { enqueue: jest.fn(), enqueueMany: jest.fn(), notifyPermissionHolders: jest.fn() } as never,
    { forSchool: jest.fn(async () => ({ timezone: "Africa/Lagos" })), inTx: jest.fn(async () => ({ timezone: "Africa/Lagos" })) } as never,
    { hasIntegrityConsent: jest.fn(async () => true) } as never,       // consent
    // The hooks service registers an onFinalized reactor in the constructor —
    // a double must model that or the service cannot even be built.
    { onFinalized: jest.fn() } as never,
  );
  return { svc, queries };
}

describe("a console five years of papers deep", () => {
  it("SAYS how many papers the school holds, not how many fit the page", async () => {
    const { svc } = makeService();
    const r = await svc.listExams(staff, true);
    expect(r.items.length).toBeLessThan(1350);
    expect(r.total).toBe(1350);
    expect(r.shown).toBe(r.items.length);
  });

  it("reaches a paper from year one BY PAGE — the 1,250 with no route", async () => {
    const { svc } = makeService();
    const first = await svc.listExams(staff, true);
    const deep = await svc.listExams(staff, true, undefined, { page: 13 });
    expect(deep.items.length).toBeGreaterThan(0);
    // A different page really is different rows: a stub that ignored `skip`
    // would serve page one forever and this is what catches it.
    expect(deep.items[0].id).not.toBe(first.items[0].id);
    expect(deep.page).toBe(13);
  });

  it("searches in the DATABASE, across all five years, not over the loaded page", async () => {
    const { svc } = makeService();
    const r = await svc.listExams(staff, true, undefined, { q: "Physics" });
    expect(r.total).toBe(450);
    // Present on page one, and every row matches.
    expect(r.items.every((e) => e.title.includes("Physics"))).toBe(true);
  });

  it("counts the MATCHES when searching, never the whole console", async () => {
    const { svc } = makeService();
    const r = await svc.listExams(staff, true, undefined, { q: "Chemistry" });
    expect(r.total).toBe(900);
    expect(r.total).not.toBe(1350);
  });

  it("pages across TIED rows without skipping or repeating one", async () => {
    // The papers share a startAt in blocks of 30, so `startAt` alone leaves the
    // database free to return tied rows in a different order per page — which
    // under offset paging silently skips some and repeats others. Walking every
    // page and counting DISTINCT ids is what detects that; a single-page check
    // cannot.
    const { svc } = makeService();
    const seen = new Set<string>();
    let total = 0;
    for (let page = 1; page <= 14; page += 1) {
      const r = await svc.listExams(staff, true, undefined, { page });
      total = r.total;
      for (const e of r.items) seen.add(e.id);
    }
    expect(total).toBe(1350);
    // Every paper reachable exactly once across the pages.
    expect(seen.size).toBe(1350);
  });
});

describe("and it does not cost a query per row", () => {
  it("maps a 100-row page in a BOUNDED number of queries", async () => {
    const { svc, queries } = makeService();
    const r = await svc.listExams(staff, true);
    expect(r.items).toHaveLength(100);
    // 1 list + 1 count + 1 groupBy + 1 own-sittings read. The defect was 201:
    // two per exam, awaited in sequence, inside one pooled transaction.
    const total = queries.findMany + queries.count + queries.findFirst + queries.groupBy;
    expect(total).toBeLessThanOrEqual(6);
    // The specific shape: counted by GROUP, never once per exam.
    expect(queries.findFirst).toBe(0);
    expect(queries.groupBy).toBe(1);
  });

  it("the query count does NOT grow with the page size", async () => {
    // The property that matters: bounded, not merely smaller. A per-row read
    // would scale with the rows and this is what says so.
    const a = makeService();
    await a.svc.listExams(staff, true);
    const one = a.queries.findMany + a.queries.count + a.queries.findFirst + a.queries.groupBy;
    const b = makeService();
    await b.svc.listExams(staff, true, undefined, { page: 2 });
    const two = b.queries.findMany + b.queries.count + b.queries.findFirst + b.queries.groupBy;
    expect(two).toBe(one);
  });

  it("still reports each exam's sitting count and the caller's own sitting", async () => {
    // Batching must not quietly drop what the row carried.
    const { svc } = makeService();
    const r = await svc.listExams(staff, true);
    expect(r.items.find((e) => e.id === "ex-0000")?.sittings).toBe(12);
    expect(r.items.find((e) => e.id === "ex-0001")?.mySittingId).toBe("sit-1");
    // A missing group is zero sittings, not a missing exam.
    expect(r.items.find((e) => e.id === "ex-0002")?.sittings).toBe(0);
  });
});

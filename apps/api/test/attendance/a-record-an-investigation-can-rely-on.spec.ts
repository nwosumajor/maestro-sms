// =============================================================================
// A pupil's attendance, compiled for audit — and what makes it trustworthy
// =============================================================================
// The record answered "which days" (paged) and "this term so far". Neither
// answers what an investigation asks: how many days was this child absent in
// each month of Year 9, and how does that compare with Year 8? Reading that off
// a day list means paging a thousand rows and counting by hand, which is how a
// wrong number reaches a meeting.
//
// TWO THINGS DECIDE WHETHER THE ANSWER CAN BE RELIED ON, and both are easy to
// get wrong in a way that looks entirely plausible:
//
// 1. `attendance_term_rollup` is computed once when a term ENDS and never
//    recomputed — which is exactly what an audit wants, the figure the school
//    reported at the time. But it covers ENDED terms ONLY. Reading the table
//    alone shows the CURRENT term as zero, which reads as "never attended"
//    rather than "not settled yet".
//
// 2. The rollup is keyed `(termId, classId, studentId)`, so a pupil who moved
//    class mid-term has SEVERAL rows for one term. Taking the first reports a
//    fraction of the term and looks completely normal.
// =============================================================================

import { AttendanceService } from "../../src/attendance/attendance.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const head: Principal = { schoolId: "S", userId: "head", roles: ["principal"], permissions: ["attendance.read"] };
const PUPIL = "pupil-1";

const SESSIONS = [
  { id: "sess-2", name: "2025/2026", startDate: new Date("2025-09-01"), endDate: new Date("2026-07-31") },
  { id: "sess-1", name: "2024/2025", startDate: new Date("2024-09-01"), endDate: new Date("2025-07-31") },
];
const TERMS = [
  { id: "t4", name: "Third Term", startDate: new Date("2026-04-20"), endDate: new Date("2026-07-24"), sessionId: "sess-2" },
  { id: "t3", name: "Second Term", startDate: new Date("2026-01-08"), endDate: new Date("2026-03-27"), sessionId: "sess-2" },
  { id: "t2", name: "First Term", startDate: new Date("2025-09-08"), endDate: new Date("2025-12-12"), sessionId: "sess-2" },
  { id: "t1", name: "Third Term", startDate: new Date("2025-04-20"), endDate: new Date("2025-07-24"), sessionId: "sess-1" },
];

function makeService(opts: {
  /** termId -> rollup rows (more than one = the pupil changed class mid-term). */
  rollups?: Array<{ termId: string; classId?: string; present: number; absent: number; late: number; excused: number }>;
  live?: Record<string, { present: number; absent: number; late: number; excused: number }>;
  months?: Array<{ key: string; present: number; absent: number; late: number; excused: number }>;
} = {}) {
  const { rollups = [], live = {}, months = [] } = opts;
  const tx = {
    user: { findFirst: jest.fn(async () => ({ name: "Ada Pupil" })) },
    term: { findMany: jest.fn(async () => TERMS) },
    academicSession: { findMany: jest.fn(async () => SESSIONS) },
    class: { findMany: jest.fn(async () => []) },
    enrollment: { findMany: jest.fn(async () => []) },
    classSubjectTeacher: { findMany: jest.fn(async () => []) },
    parentChild: { findFirst: jest.fn(async () => null) },
    attendanceTermRollup: {
      // HONOURS `by`, which is the whole point of this double.
      //
      // It used to sum per term whatever it was asked for — so the service could
      // have grouped by (termId, classId), handed back one row per CLASS, and
      // every assertion here would still have passed while a pupil who changed
      // class mid-term reported a fraction of the term. Verified: mutating the
      // service to group per class passed against the old stub and fails
      // against this one. A double must model the CONTRACT, not the signature.
      groupBy: jest.fn(async (a: { by?: string[] }) => {
        const by = a?.by ?? ["termId"];
        const key = (r: (typeof rollups)[number]) => by.map((f) => (f === "termId" ? r.termId : r.classId ?? "c1")).join("|");
        const acc = new Map<string, { row: (typeof rollups)[number]; sum: { present: number; absent: number; late: number; excused: number } }>();
        for (const r of rollups) {
          const k = key(r);
          const cur = acc.get(k)?.sum ?? { present: 0, absent: 0, late: 0, excused: 0 };
          acc.set(k, {
            row: r,
            sum: {
              present: cur.present + r.present, absent: cur.absent + r.absent,
              late: cur.late + r.late, excused: cur.excused + r.excused,
            },
          });
        }
        return [...acc.values()].map(({ row, sum }) => ({ termId: row.termId, classId: row.classId ?? "c1", _sum: sum }));
      }),
    },
    attendanceRecord: {
      groupBy: jest.fn(async (a: { where?: { date?: { gte?: Date } } }) => {
        const from = a?.where?.date?.gte;
        const term = TERMS.find((t) => from && t.startDate.getTime() === from.getTime());
        const c = term ? live[term.id] : undefined;
        const lifetime = { present: 300, absent: 20, late: 10, excused: 5 };
        const use = term ? (c ?? { present: 0, absent: 0, late: 0, excused: 0 }) : lifetime;
        return [
          { status: "PRESENT", _count: { _all: use.present } },
          { status: "ABSENT", _count: { _all: use.absent } },
          { status: "LATE", _count: { _all: use.late } },
          { status: "EXCUSED", _count: { _all: use.excused } },
        ];
      }),
    },
    $queryRaw: jest.fn(async () =>
      months.map((m) => ({
        key: m.key,
        from_date: new Date(`${m.key}-01`),
        to_date: new Date(`${m.key}-28`),
        present: m.present, absent: m.absent, late: m.late, excused: m.excused,
      })),
    ),
  } as unknown as TenantTx;

  const svc = new AttendanceService(
    {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn(), notifyPermissionHolders: jest.fn() } as never,
    { createRequest: jest.fn(), submit: jest.fn() } as never,
    { forSchool: async () => ({ timezone: "Africa/Lagos" }), inTx: async () => ({ timezone: "Africa/Lagos" }), todayInTx: async () => new Date() } as never,
    { onFinalized: jest.fn() } as never,
  );
  return { svc, tx };
}

describe("the current term is not zero", () => {
  it("computes a term with NO rollup live, rather than reporting nothing", async () => {
    // The rollup only covers ENDED terms. Reading it alone would show the term
    // everybody cares about as a row of noughts.
    const { svc } = makeService({
      rollups: [{ termId: "t1", present: 60, absent: 2, late: 1, excused: 0 }],
      live: { t4: { present: 40, absent: 3, late: 2, excused: 1 } },
    });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "term" });
    const current = r.buckets.find((b) => b.key === "t4")!;
    expect(current.present).toBe(40);
    expect(current.total).toBe(46);
  });

  it("SAYS which figures are settled and which are still moving", async () => {
    // Provenance is the point in an audit: a reader who cannot tell a settled
    // figure from a moving one cannot cite either.
    const { svc } = makeService({
      rollups: [{ termId: "t1", present: 60, absent: 2, late: 1, excused: 0 }],
      live: { t4: { present: 40, absent: 3, late: 2, excused: 1 } },
    });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "term" });
    expect(r.buckets.find((b) => b.key === "t1")!.source).toBe("ROLLUP");
    expect(r.buckets.find((b) => b.key === "t4")!.source).toBe("LIVE");
  });
});

describe("a pupil who changed class mid-term", () => {
  it("SUMS their rollup rows instead of reporting a fraction of the term", async () => {
    // (termId, classId, studentId) — two classes, two rows, one term.
    const { svc } = makeService({
      rollups: [
        { termId: "t2", classId: "class-A", present: 30, absent: 1, late: 0, excused: 0 },
        { termId: "t2", classId: "class-B", present: 28, absent: 2, late: 1, excused: 1 },
      ],
    });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "term" });
    const t2 = r.buckets.find((b) => b.key === "t2")!;
    expect(t2.present).toBe(58);
    expect(t2.total).toBe(63);
  });
});

describe("a session is the sum of its terms", () => {
  it("adds up to exactly what the terms beneath it say", async () => {
    // Built from the term buckets, not from a second query over the register:
    // two paths to one figure is how a year total comes to disagree with the
    // terms printed under it.
    const { svc } = makeService({
      rollups: [
        { termId: "t2", present: 50, absent: 2, late: 1, excused: 0 },
        { termId: "t3", present: 55, absent: 1, late: 2, excused: 1 },
        { termId: "t4", present: 45, absent: 3, late: 0, excused: 2 },
      ],
    });
    const terms = await svc.compiledHistory(head, PUPIL, { grain: "term" });
    const sessions = await svc.compiledHistory(head, PUPIL, { grain: "session" });
    const s2 = sessions.buckets.find((b) => b.key === "sess-2")!;
    const own = terms.buckets.filter((b) => ["t2", "t3", "t4"].includes(b.key));
    expect(s2.present).toBe(own.reduce((n, b) => n + b.present, 0));
    expect(s2.total).toBe(own.reduce((n, b) => n + b.total, 0));
  });

  it("is only as SETTLED as its least settled term", async () => {
    // One term still being counted means the year total is still moving.
    const { svc } = makeService({
      rollups: [
        { termId: "t2", present: 50, absent: 2, late: 1, excused: 0 },
        { termId: "t3", present: 55, absent: 1, late: 2, excused: 1 },
      ],
      live: { t4: { present: 10, absent: 0, late: 0, excused: 0 } },
    });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "session" });
    expect(r.buckets.find((b) => b.key === "sess-2")!.source).toBe("LIVE");
  });
});

describe("what the page does not hide", () => {
  it("carries LIFETIME totals independent of the grain and the page", async () => {
    // An audit that reports only what fitted on a page is worse than one that
    // says nothing.
    const { svc } = makeService({ rollups: [{ termId: "t1", present: 60, absent: 2, late: 1, excused: 0 }] });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "term" });
    expect(r.lifetime).toMatchObject({ present: 300, absent: 20, late: 10, excused: 5, total: 335 });
  });

  it("counts the buckets that exist, not the ones on the page", async () => {
    const { svc } = makeService({ rollups: [] });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "term" });
    expect(r.total).toBe(TERMS.length);
  });

  it("rates LATE as attending and EXCUSED as not — the report card's rule", async () => {
    const { svc } = makeService({ rollups: [{ termId: "t1", present: 54, absent: 2, late: 9, excused: 5 }] });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "term" });
    const t1 = r.buckets.find((b) => b.key === "t1")!;
    // (54 + 9) / 70 = 90%, matching the card rather than the 97% an earlier
    // version of the summary produced by counting excused as attendance.
    expect(t1.percent).toBe(90);
  });

  it("reports a rate of NULL over no registers, not 0%", async () => {
    // A rate over nothing is unknown, not zero — and 0% reads as truancy.
    const { svc } = makeService({ rollups: [], live: {} });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "term" });
    expect(r.buckets[0].percent).toBeNull();
  });
});

describe("months", () => {
  it("compiles per calendar month and labels them readably", async () => {
    const { svc } = makeService({
      months: [
        { key: "2026-03", present: 18, absent: 2, late: 1, excused: 0 },
        { key: "2026-02", present: 16, absent: 0, late: 0, excused: 1 },
      ],
    });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "month" });
    expect(r.buckets.map((b) => b.label)).toEqual(["March 2026", "February 2026"]);
    expect(r.buckets[0]).toMatchObject({ present: 18, absent: 2, total: 21, source: "LIVE" });
  });

  it("never claims a month came from the rollup — there is no month rollup", async () => {
    const { svc } = makeService({ months: [{ key: "2026-03", present: 1, absent: 0, late: 0, excused: 0 }] });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "month" });
    expect(r.buckets.every((b) => b.source === "LIVE")).toBe(true);
  });
});

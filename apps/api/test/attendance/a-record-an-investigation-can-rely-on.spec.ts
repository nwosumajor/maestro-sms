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
  /** The pupil's first and last recorded day — what the lifetime pass returns. */
  span?: { first: Date; last: Date };
} = {}) {
  const {
    rollups = [],
    live = {},
    months = [],
    // 30 months of span, matching the fixture's month list.
    span = { first: new Date("2024-03-01"), last: new Date("2026-08-31") },
  } = opts;
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
    // TWO different raw queries now: the lifetime pass (which also returns the
    // SPAN, so the month total needs no second scan over every partition) and
    // the month aggregate. A stub answering both with the same shape would let
    // either one break unnoticed, so it answers by what was ASKED.
    $queryRaw: jest.fn(async (q: { strings?: string[]; values?: unknown[] }) => {
      const sql = String(q?.strings?.join(" ") ?? "");
      if (/min\("date"\)/.test(sql) && !/date_trunc/.test(sql)) {
        return [{
          present: 300, absent: 20, late: 10, excused: 5,
          first_day: span.first, last_day: span.last,
        }];
      }
      // HONOURS THE DATE WINDOW, which is the whole point of this half of the
      // double. Returning every month regardless would let the service drop the
      // `AND "date" >= … AND "date" < …` predicate — the one that stops a page
      // planning every partition — with every assertion here still green.
      const [, from, to] = (q?.values ?? []) as [unknown, Date, Date];
      return months
        .filter((m) => {
          if (!(from instanceof Date) || !(to instanceof Date)) return true;
          const start = new Date(`${m.key}-01T00:00:00Z`);
          return start >= from && start < to;
        })
        .map((m) => ({
          key: m.key,
          from_date: new Date(`${m.key}-01`),
          to_date: new Date(`${m.key}-28`),
          present: m.present, absent: m.absent, late: m.late, excused: m.excused,
        }));
    }),
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

describe("what the grain cannot show", () => {
  it("NAMES the registers that fall outside every term", async () => {
    // Found on real data: one pupil's terms summed to 162 against a lifetime of
    // 193 — 16% of the record absent from the view, because registers get taken
    // in the gaps between configured term dates. A reader adding the terms up
    // would either mistrust the tool or cite the smaller number.
    const { svc } = makeService({
      rollups: [
        { termId: "t2", present: 50, absent: 2, late: 1, excused: 0 }, // 53
        { termId: "t3", present: 55, absent: 1, late: 2, excused: 1 }, // 59
      ],
      live: { t1: { present: 0, absent: 0, late: 0, excused: 0 }, t4: { present: 0, absent: 0, late: 0, excused: 0 } },
    });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "term" });
    // lifetime is 335 in the fixture; the terms account for 112.
    expect(r.lifetime.total).toBe(335);
    expect(r.outsideAnyBucket).toBe(335 - 112);
  });

  it("is ZERO for months, because every date is in some month", async () => {
    const { svc } = makeService({
      months: [
        { key: "2026-03", present: 300, absent: 20, late: 10, excused: 5 },
      ],
    });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "month" });
    expect(r.outsideAnyBucket).toBe(0);
  });

  it("never goes negative when the buckets exceed the lifetime read", async () => {
    // A rollup counts registers as they were at the time; a later purge could
    // leave the buckets ahead of the live count. A negative "missing" figure
    // would be nonsense on an audit screen.
    const { svc } = makeService({
      rollups: [{ termId: "t1", present: 5000, absent: 0, late: 0, excused: 0 }],
    });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "term" });
    expect(r.outsideAnyBucket).toBe(0);
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

describe("the month page is a DATE WINDOW, and it is anchored on the record", () => {
  // Months are paged by narrowing the SQL rather than by slicing a full fetch,
  // because `attendance_record` is partitioned by month and an aggregate with no
  // date predicate has to PLAN every partition — measured at 88.6 ms planning
  // against 9.4 ms execution on 52 partitions, a cost that grows with the
  // PLATFORM's age rather than with the pupil's record.
  //
  // That makes WHERE the window sits a correctness question, not a tuning one.

  it("puts a LEAVER's last months on page 1, not an empty window after them", async () => {
    // The defect this exists for: a window counted back from TODAY lands after
    // the final register of anyone who has left, so page 1 comes back empty
    // under a total saying thirty months of history exist. An investigation
    // opening a leaver's record is the likeliest reader of this screen.
    const { svc } = makeService({
      span: { first: new Date("2021-09-01"), last: new Date("2023-07-31") },
      months: [
        { key: "2023-07", present: 14, absent: 1, late: 0, excused: 0 },
        { key: "2023-06", present: 19, absent: 0, late: 1, excused: 0 },
      ],
    });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "month", page: 1 });
    expect(r.buckets.map((b) => b.key)).toEqual(["2023-07", "2023-06"]);
  });

  it("narrows in SQL, so a later page asks for a DIFFERENT window", async () => {
    const { svc, tx } = makeService({
      span: { first: new Date("2024-03-01"), last: new Date("2026-08-31") },
      months: [{ key: "2026-08", present: 1, absent: 0, late: 0, excused: 0 }],
    });
    const windowOf = async (page: number) => {
      (tx.$queryRaw as jest.Mock).mockClear();
      await svc.compiledHistory(head, PUPIL, { grain: "month", page });
      const call = (tx.$queryRaw as jest.Mock).mock.calls
        .map((c) => c[0] as { strings?: string[]; values?: unknown[] })
        .find((q) => /date_trunc/.test(String(q?.strings?.join(" ") ?? "")));
      const [, from, to] = (call?.values ?? []) as [unknown, Date, Date];
      return [from?.toISOString().slice(0, 10), to?.toISOString().slice(0, 10)];
    };
    // Page 1 ends just after the pupil's last recorded month; page 2 is the
    // 36 months before it. Neither is the whole record.
    expect(await windowOf(1)).toEqual(["2023-09-01", "2026-09-01"]);
    expect(await windowOf(2)).toEqual(["2020-09-01", "2023-09-01"]);
  });

  it("reports the TOTAL months from the span, never the size of the page", async () => {
    // The page is the window, so `all.length` would report the page as the whole
    // record — a pupil with thirty months of history shown as having twelve.
    const { svc } = makeService({
      span: { first: new Date("2024-03-01"), last: new Date("2026-08-31") },
      months: [{ key: "2026-08", present: 1, absent: 0, late: 0, excused: 0 }],
    });
    const r = await svc.compiledHistory(head, PUPIL, { grain: "month", page: 1 });
    expect(r.total).toBe(30);
  });
});


/**
 * WHO SAID SO, AND WHEN.
 *
 * The day list answered "what was this child marked" and stopped. An
 * investigation asks two more things and the record could answer neither:
 * WHO signed that register, and has the mark been changed since. Both facts
 * were one join away on a read that already made it — and on another screen
 * entirely for a reader who knew to go and look, and which class to look in.
 *
 * A mark RECORDED long after the day it is about is a correction. That is the
 * difference between a record and an audit record.
 */
describe("a day in the record says who signed for it", () => {
  const DAY = new Date("2026-03-12");

  function harness(sessionRow: Record<string, unknown>) {
    const tx = {
      class: { findFirst: jest.fn().mockResolvedValue({ id: "c-1" }), findMany: jest.fn().mockResolvedValue([]) },
      classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
      enrollment: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue({ id: "e-1" }) },
      parentChild: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      attendanceRecord: {
        findMany: jest.fn().mockResolvedValue([
          { id: "r-1", status: "ABSENT", note: "unwell", session: sessionRow },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
    } as unknown as TenantTx;
    const service = new AttendanceService(
      {
        runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
        runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      } as never,
      { record: jest.fn() } as never,
      { enqueue: jest.fn(), enqueueMany: jest.fn() } as never,
      { createRequest: jest.fn(), submit: jest.fn() } as never,
      { forSchool: jest.fn().mockResolvedValue({ timezone: "Africa/Lagos" }), todayInTx: async () => new Date() } as never,
      { onFinalized: jest.fn() } as never,
    );
    return { service, tx };
  }

  it("carries the member of staff the register is signed by", async () => {
    const { service } = harness({
      classId: "c-1", date: DAY, updatedAt: DAY,
      class: { name: "SS1 Science A" },
      takenBy: { id: "u-akinlabi", name: "Akinlabi Alex" },
    });
    const out = await service.getStudentAttendance(head, PUPIL, {});
    expect(out.records[0].session).toMatchObject({
      takenBy: { id: "u-akinlabi", name: "Akinlabi Alex" },
      className: "SS1 Science A",
    });
  });

  it("carries WHEN it was written, so a late correction is visible against its own date", async () => {
    // Marked for 12 March, written on 2 April: a correction, and the only thing
    // that distinguishes it from a mark made on the day.
    const { service } = harness({
      classId: "c-1", date: DAY, updatedAt: new Date("2026-04-02"),
      class: { name: "SS1 Science A" },
      takenBy: { id: "u-akinlabi", name: "Akinlabi Alex" },
    });
    const out = await service.getStudentAttendance(head, PUPIL, {});
    const rec = out.records[0].session;
    expect(new Date(rec.recordedAt).toISOString().slice(0, 10)).toBe("2026-04-02");
    expect(new Date(rec.date).toISOString().slice(0, 10)).toBe("2026-03-12");
  });

  it("survives a register whose taker has since been removed", async () => {
    // The person leaves; the record of the day does not. Null, not a crash and
    // not a blank row — the rest of the fact is still evidence.
    const { service } = harness({
      classId: "c-1", date: DAY, updatedAt: DAY, class: null, takenBy: null,
    });
    const out = await service.getStudentAttendance(head, PUPIL, {});
    expect(out.records[0].session).toMatchObject({ takenBy: null, className: null, classId: "c-1" });
    expect(out.records[0].status).toBe("ABSENT");
  });
});

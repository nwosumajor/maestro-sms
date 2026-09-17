// =============================================================================
// "How has this person's attendance been?" had no answer in the product
// =============================================================================
// The register showed TODAY. The roll-up showed THIS MONTH across everybody. The
// only per-person read was `myHistory` — self-only, 60 rows, no count, no paging
// and no monthly compilation. So the question a head of school actually asks
// about one colleague could not be asked at all, and the staff detail page had
// no attendance section.
//
// THE SHAPE THAT MATTERS: a per-day read is O(how long the person has worked
// here) — roughly 250 rows a year, so somebody in year eight costs eight times
// what a new starter does for a screen that shows the same thing. That is the
// failure this repo keeps recording: it degrades invisibly and only in
// production.
//
// Measured as the app role, under RLS, with a bound parameter, on 250,440 rows
// (120 staff x 8 years):
//
//   existing (userId,date) index only     Bitmap Heap Scan   41.8 ms
//   plain (schoolId,userId,date)          Index Scan         34.8 ms
//   with INCLUDE (the one shipped)        Index Only Scan    12.5 ms
//
// So the months are COMPILED IN SQL and paged, and the day detail is one month —
// bounded by the calendar at 31 rows.
// =============================================================================

import { StaffAttendanceService } from "../../src/hr/attendance.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const head: Principal = {
  schoolId: "S",
  userId: "head-1",
  roles: ["principal"],
  permissions: ["hr.attendance.read"],
};

/** 30 months of history, so a 12-month page cannot be the whole of it. */
const MONTHS = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 8 - i, 1));
  return {
    month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    present: 18,
    late: 2,
    absent: 1,
    on_leave: 1,
    flagged: 0,
    open_spans: i === 0 ? 2 : 0,
    minutes: 9600,
    closed: 20,
  };
});

function makeService(opts: { months?: typeof MONTHS; subject?: { id: string; name: string } | null } = {}) {
  const all = opts.months ?? MONTHS;
  const queries: string[] = [];
  const tx = {
    user: { findFirst: jest.fn(async () => (opts.subject === undefined ? { id: "staff-2", name: "Amaka Obi" } : opts.subject)) },
    // HONOURS limit/offset the way the database does — a stub returning the whole
    // set proves nothing about a service that stopped paging.
    $queryRaw: jest.fn(async (q: { strings?: string[]; values?: unknown[]; sql?: string; text?: string }) => {
      const sql = String((q as { strings?: string[] }).strings?.join(" ") ?? (q as { sql?: string }).sql ?? "");
      queries.push(sql);
      if (/count\(DISTINCT/.test(sql)) return [{ n: all.length }];
      const vals = (q as { values?: unknown[] }).values ?? [];
      const limit = Number(vals[vals.length - 2] ?? 12);
      const offset = Number(vals[vals.length - 1] ?? 0);
      return all.slice(offset, offset + limit);
    }),
    staffAttendance: {
      findMany: jest.fn(async () => [
        {
          id: "d1",
          userId: "staff-2",
          date: new Date("2026-08-03"),
          status: "LATE",
          source: "SELF_KIOSK",
          clockInAt: new Date("2026-08-03T08:15:00Z"),
          clockOutAt: new Date("2026-08-03T16:00:00Z"),
          flagged: false,
          note: null,
        },
      ]),
    },
  } as unknown as TenantTx;
  const svc = new StaffAttendanceService(
    {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    { forSchool: async () => ({ timezone: "Africa/Lagos" }) } as never,
    { createRequest: jest.fn(), submit: jest.fn() } as never,
    { onFinalized: jest.fn() } as never,
  );
  return { svc, tx, queries };
}

describe("one member of staff's record", () => {
  it("compiles the month totals rather than counting fetched rows", async () => {
    const { svc, queries } = makeService();
    const r = await svc.staffHistory(head, "staff-2");
    // The aggregate is the source. A service that hydrated days and counted them
    // in Node would still pass a naive assertion on the numbers.
    expect(queries.some((q) => /date_trunc/.test(q) && /FILTER/.test(q))).toBe(true);
    expect(r.months[0]).toMatchObject({ present: 18, late: 2, absent: 1, onLeave: 1 });
  });

  it("SAYS how much history exists, not just what fits the page", async () => {
    // A page presented as the whole record is how a reader concludes somebody
    // has no history — the commonest defect in this repo.
    const { svc } = makeService();
    const r = await svc.staffHistory(head, "staff-2");
    expect(r.months.length).toBeLessThan(MONTHS.length);
    expect(r.totalMonths).toBe(30);
    expect(r.pageSize).toBe(r.months.length);
  });

  it("counts the total in the DATABASE, over the same predicate", async () => {
    const { svc, queries } = makeService();
    await svc.staffHistory(head, "staff-2");
    const countQ = queries.find((q) => /count\(DISTINCT/.test(q));
    expect(countQ).toBeDefined();
    expect(countQ).toMatch(/"userId"/);
  });

  it("reaches an older year by paging, so nothing is stranded", async () => {
    const { svc } = makeService();
    const first = await svc.staffHistory(head, "staff-2");
    const second = await svc.staffHistory(head, "staff-2", { page: 2 });
    expect(second.page).toBe(2);
    expect(second.months[0].month).not.toBe(first.months[0].month);
    // Contiguous: page 2 starts exactly where page 1 stopped.
    expect(second.months[0].month).toBe(MONTHS[12].month);
  });

  it("does not read a DAY for every month — the detail is one month only", async () => {
    // The day rows are what would grow without bound; the calendar bounds them.
    const { svc, tx } = makeService();
    await svc.staffHistory(head, "staff-2");
    const findMany = (tx as unknown as { staffAttendance: { findMany: jest.Mock } }).staffAttendance.findMany;
    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0][0].where;
    expect(where.date).toHaveProperty("gte");
    expect(where.date).toHaveProperty("lt");
  });

  it("reports NULL hours for a month with nothing closed — not zero", async () => {
    // "No day in this month has a clock-out" and "this month had no hours" are
    // different facts; printing 0h asserts the second.
    const { svc } = makeService({
      months: [{ ...MONTHS[0], minutes: 0, closed: 0 }],
    });
    const r = await svc.staffHistory(head, "staff-2");
    expect(r.months[0].minutesOnSite).toBeNull();
  });

  it("keeps days left OPEN as their own number", async () => {
    const { svc } = makeService();
    const r = await svc.staffHistory(head, "staff-2");
    expect(r.months[0].openSpans).toBe(2);
    expect(r.months[0].absent).toBe(1); // not folded together
  });

  it("404s somebody who is not in this school — never confirming they exist", async () => {
    // RLS already confines the read; the refusal must not tell the two apart.
    const { svc } = makeService({ subject: null });
    await expect(svc.staffHistory(head, "someone-elses-staff")).rejects.toThrow(/not found/i);
  });
});

// =============================================================================
// 540 sittings held, 200 returned, and no way to ask for the rest
// =============================================================================
// `GET /exams` listed a school's exam sittings: a bare array, ordered by date
// descending, capped at 200, with no count. A sitting is a RECORD — who sat
// where, the attendance taken in the hall, the paper it belongs to — and a
// school accumulates them every term.
//
// Measured on a secondary three years in (9 terms x 6 year groups x 10 papers):
//
//     held                540
//     returned            200
//     covered             2025-05-15 .. 2026-05-13   (the most recent year)
//     said there was more nothing
//
// The API has ALWAYS accepted `q`, `hall`, `from`, `to` and `scheduleId`. The
// page sent none of them: the planner's search and hall controls filtered the
// already-loaded page in the browser — its own comment called that "fast local
// whittling", which is right only if the loaded page is the whole set — and
// nothing anywhere set `?schedule=`, though the page reads it.
//
// So 336 of 540 sittings, two full years, could not be reached through the
// screen at all. Not slower to find: absent, with no control that would have
// produced them.
// =============================================================================

import { ExamService } from "../../src/exam/exam.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const head: Principal = {
  schoolId: "A",
  userId: "head",
  roles: ["principal"],
  permissions: ["exam.manage", "exam.release"],
};

type Row = {
  id: string;
  title: string;
  subject: string | null;
  date: Date;
  startsAt: Date;
  endsAt: Date;
  hall: string;
  capacity: number;
  note: string | null;
  scheduleId: string | null;
  cbtExamId: string | null;
  roomId: string | null;
  classId: string | null;
};

/** Three years of papers: 9 terms x 6 year groups x 10 subjects = 540. */
const SITTINGS: Row[] = [];
for (let term = 1; term <= 9; term += 1) {
  for (let yg = 1; yg <= 6; yg += 1) {
    for (let sub = 1; sub <= 10; sub += 1) {
      const d = new Date(Date.UTC(2026, 8, 11) - (term * 120 + sub) * 86_400_000);
      SITTINGS.push({
        id: `s-${term}-${yg}-${sub}`,
        title: `Y${yg} Subject${sub} Paper`,
        subject: `Subject${sub}`,
        date: d,
        startsAt: d,
        endsAt: d,
        hall: `Hall ${String.fromCharCode(64 + yg)}`,
        capacity: 200,
        note: null,
        scheduleId: `sch-${term}`,
        cbtExamId: null,
        roomId: null,
        classId: null,
      });
    }
  }
}

function makeService(rows = SITTINGS) {
  const select = (where: Record<string, unknown> = {}) =>
    rows.filter((r) => {
      if (where.scheduleId && r.scheduleId !== where.scheduleId) return false;
      const hall = where.hall as { equals?: string } | undefined;
      if (hall?.equals && r.hall.toLowerCase() !== hall.equals.toLowerCase()) return false;
      const date = where.date as { gte?: Date; lte?: Date } | Date | undefined;
      if (date instanceof Date && r.date.getTime() !== date.getTime()) return false;
      if (date && !(date instanceof Date)) {
        if (date.gte && r.date < date.gte) return false;
        if (date.lte && r.date > date.lte) return false;
      }
      const or = where.OR as Array<Record<string, { contains?: string }>> | undefined;
      if (or) {
        const needle = (or[0]?.title?.contains ?? "").toLowerCase();
        const hay = `${r.title} ${r.subject ?? ""}`.toLowerCase();
        if (needle && !hay.includes(needle)) return false;
      }
      return true;
    });

  const tx = {
    examSitting: {
      // Honours where AND take — a stub ignoring either invents a cap that is
      // not there, or hides one that is.
      findMany: jest.fn(async ({ where, take }: { where?: Record<string, unknown>; take?: number }) => {
        const out = select(where).sort((a, b) => b.date.getTime() - a.date.getTime() || (a.id < b.id ? -1 : 1));
        return take ? out.slice(0, take) : out;
      }),
      count: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => select(where).length),
    },
    examSeat: { groupBy: jest.fn(async () => []), count: jest.fn(async () => 0) },
    examInvigilator: { groupBy: jest.fn(async () => []), count: jest.fn(async () => 0) },
    cbtExam: { findMany: jest.fn(async () => []) },
    cbtSitting: { groupBy: jest.fn(async () => []) },
    class: { findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;

  const svc = new ExamService(
    {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn(), notifyPermissionHolders: jest.fn() } as never,
    { forSchool: jest.fn(async () => ({ timezone: "Africa/Lagos" })), inTx: jest.fn(async () => ({ timezone: "Africa/Lagos" })) } as never,
    { createRequest: jest.fn(), submit: jest.fn() } as never,
    // The hooks service registers an onFinalized reactor in the constructor —
    // a double must model that or the service cannot even be built.
    { onFinalized: jest.fn() } as never,
  );
  return { svc, tx };
}

describe("a school three years into its exam history", () => {
  it("SAYS HOW MANY SITTINGS IT HELD, not how many fit the page", async () => {
    const { svc } = makeService();
    const r = await svc.listSittings(head);
    expect(r.items.length).toBeLessThan(540);
    expect(r.total).toBe(540);
    expect(r.pageSize).toBe(r.items.length);
  });

  it("reaches a term from two years ago BY SCHEDULE — the filter nothing sent", async () => {
    const { svc } = makeService();
    const recent = await svc.listSittings(head);
    // The oldest term is not on the first page: this is what was unreachable.
    expect(recent.items.some((s) => s.id.startsWith("s-9-"))).toBe(false);
    const old = await svc.listSittings(head, { scheduleId: "sch-9" });
    expect(old.total).toBe(60);
    expect(old.items.every((s) => s.id.startsWith("s-9-"))).toBe(true);
  });

  it("reaches it by SUBJECT too, across the whole history", async () => {
    const { svc } = makeService();
    const r = await svc.listSittings(head, { q: "Subject7" });
    // 9 terms x 6 year groups, not merely the ones on the recent page.
    expect(r.total).toBe(54);
    expect(r.items.length).toBe(54);
  });

  it("and by HALL", async () => {
    const { svc } = makeService();
    const r = await svc.listSittings(head, { hall: "hall c" });
    expect(r.total).toBe(90);
  });

  it("counts the MATCHES when filtered, not the whole history", async () => {
    const { svc } = makeService();
    const r = await svc.listSittings(head, { scheduleId: "sch-4" });
    expect(r.total).toBe(60);
    expect(r.total).not.toBe(540);
  });

  it("counts in the DATABASE, over the same predicate the page draws from", async () => {
    const { svc, tx } = makeService();
    const count = (tx as unknown as { examSitting: { count: jest.Mock } }).examSitting.count;
    await svc.listSittings(head, { scheduleId: "sch-2" });
    expect(count).toHaveBeenCalled();
    expect(count.mock.calls[0][0].where).toMatchObject({ scheduleId: "sch-2" });
  });

  it("orders by a TOTAL order, so the page is stable", async () => {
    // A term's papers share dates and start times; `date` and `startsAt` alone
    // leave ties, and a capped read over a partial order is not reproducible.
    const { svc, tx } = makeService();
    await svc.listSittings(head);
    const orderBy = (tx as unknown as { examSitting: { findMany: jest.Mock } }).examSitting.findMany.mock.calls[0][0].orderBy;
    expect(JSON.stringify(orderBy)).toMatch(/"id"/);
  });

  it("a small school is unchanged and complete", async () => {
    const { svc } = makeService(SITTINGS.slice(0, 12));
    const r = await svc.listSittings(head);
    expect(r.total).toBe(12);
    expect(r.items).toHaveLength(12);
  });
});

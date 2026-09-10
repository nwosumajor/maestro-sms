// =============================================================================
// 1,200 submitted, 500 shown, and no number anywhere
// =============================================================================
// The SIS profile review queue read `take: 500` ordered oldest-first, with no
// page and no total. The service's own comment beside it already named the case:
//
//     "At the start of a term a large school submits far more than 500 at once."
//
// This is the SECOND time this queue's cap has been wrong, and the two are
// different faults. The first was that the cap bounded the wrong rows — it read
// the 500 oldest in the SCHOOL and then kept the caller's own, so a supervisor
// whose class submitted late saw an empty screen (see
// `a-cap-must-bound-your-own-rows.spec.ts`). That was fixed by moving the
// relationship into the WHERE clause. What remained is this: the cap now bounds
// the right rows and still says nothing about how many there are.
//
// Measured on a secondary of 1,200 who all submitted at term start — which is
// exactly what the product asks families to do:
//
//     1,200 waiting, 500 returned, as a bare array
//     the last row on screen was dated 2026-09-01
//     submissions ran to 2026-09-09
//
// Oldest-first means the RIGHT rows were visible, which is the good half: the
// newest fall off and will be there tomorrow. The bad half is that a reviewer
// who cleared the screen had nothing to tell them 700 sat behind it.
// =============================================================================

import { SisService } from "../../src/sis/sis.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const office: Principal = {
  schoolId: "A",
  userId: "head",
  roles: ["school_admin"],
  permissions: ["student.profile.read", "student.profile.review", "rbac.manage"],
};

type Row = { studentId: string; profileStatus: string; submittedAt: Date; supervisorReviewedAt: Date | null };

/** `n` profiles submitted in a term-start surge — many sharing a timestamp. */
const surge = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    studentId: `stu-${String(i).padStart(4, "0")}`,
    profileStatus: "SUBMITTED",
    // A fortnight of submissions, so dozens land on each day — which is what
    // makes `submittedAt` alone a partial order.
    submittedAt: new Date(2026, 7, 27 + (i % 14)),
    supervisorReviewedAt: null,
  }));

function makeService(rows: Row[]) {
  const tx = {
    studentProfile: {
      findMany: jest.fn(async ({ orderBy, skip = 0, take = 50 }: { orderBy?: unknown; skip?: number; take?: number }) => {
        // Tied rows come back arbitrarily, as they do in Postgres. `Array.sort`
        // is stable in V8, so a double that merely sorts cannot tell a partial
        // order from a total one — this repo has been caught by that three
        // times, and a term-start surge is exactly where ties are dense.
        const out = [...rows];
        for (let i = out.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [out[i], out[j]] = [out[j], out[i]];
        }
        const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
        out.sort((a, b) => {
          for (const k of keys) {
            const [field, dir] = Object.entries(k ?? {})[0] ?? [];
            if (!field) continue;
            const av = a[field as keyof Row];
            const bv = b[field as keyof Row];
            const d =
              av instanceof Date && bv instanceof Date
                ? av.getTime() - bv.getTime()
                : String(av ?? "") < String(bv ?? "") ? -1 : String(av ?? "") > String(bv ?? "") ? 1 : 0;
            if (d !== 0) return d * (dir === "desc" ? -1 : 1);
          }
          return 0;
        });
        return out.slice(skip, skip + take);
      }),
      count: jest.fn(async () => rows.length),
    },
    enrollment: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => rows.map((r) => ({ id: r.studentId, name: `Pupil ${r.studentId}` }))) },
  } as unknown as TenantTx;

  const svc = new SisService(
    {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    { enqueue: jest.fn() } as never,
  );
  return { svc, tx };
}

describe("the profile review queue at a term start", () => {
  it("SAYS HOW MANY ARE WAITING, not how many fit on the screen", async () => {
    const { svc } = makeService(surge(1200));
    const page = await svc.profileReviewQueue(office);
    expect(page.total).toBe(1200);
    expect(page.items).toHaveLength(page.pageSize);
    expect(page.page).toBe(1);
  });

  it("lets the reviewer reach ALL of them, not the first 500", async () => {
    const { svc } = makeService(surge(1200));
    const seen = new Set<string>();
    let page = 1;
    for (;;) {
      const out = await svc.profileReviewQueue(office, { page });
      out.items.forEach((r) => seen.add(r.studentId));
      if (page * out.pageSize >= out.total) break;
      page += 1;
      if (page > 40) break;
    }
    expect(seen.size).toBe(1200);
  });

  it("still works OLDEST FIRST — the longest wait is the top of the queue", async () => {
    // The good half of the old behaviour, kept: a family waiting since the 27th
    // is served before one that submitted yesterday.
    const { svc } = makeService(surge(1200));
    const page = await svc.profileReviewQueue(office);
    const dates = page.items.map((r) => new Date(r.submittedAt!).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
    expect(new Date(page.items[0].submittedAt!).getDate()).toBe(27);
  });

  it("pages without losing a row, though dozens share a submission day", async () => {
    // A term-start surge puts many submissions on one date; `submittedAt` alone
    // is a partial order and offset paging over one skips and repeats.
    const { svc } = makeService(surge(300));
    const seen = new Set<string>();
    for (let page = 1; page <= 10; page += 1) {
      const out = await svc.profileReviewQueue(office, { page });
      out.items.forEach((r) => seen.add(r.studentId));
      if (page * out.pageSize >= out.total) break;
    }
    expect(seen.size).toBe(300);
  });

  it("a small school is unchanged and complete", async () => {
    const { svc } = makeService(surge(40));
    const page = await svc.profileReviewQueue(office);
    expect(page.total).toBe(40);
    expect(page.items).toHaveLength(40);
  });

  it("counts in the DATABASE rather than measuring the page it fetched", async () => {
    const { svc, tx } = makeService(surge(1200));
    await svc.profileReviewQueue(office);
    expect((tx as unknown as { studentProfile: { count: jest.Mock } }).studentProfile.count).toHaveBeenCalled();
  });
});

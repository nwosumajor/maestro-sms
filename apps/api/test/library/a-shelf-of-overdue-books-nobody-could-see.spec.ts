// =============================================================================
// 1,316 overdue, and the lending desk could reach 14
// =============================================================================
// `listLoans` returned a bare array of the 300 most recent loans — no page, no
// total, no way to ask for the rows that matter. A library is a LEDGER a school
// reads for years, not a queue of live work.
//
// Measured on a 1,200-pupil secondary three years in (12,000 loans):
//
//     GET /library/loans  ->  300 rows, covering 2026-08-18 .. 2026-09-11
//     the strip above it  ->  "Overdue: 1,316"
//     overdue rows in the list                    14
//     overdue rows a librarian could reach at all  14
//
// The screen contradicted itself and the list was the half that was wrong. And
// the failure is not random: an OVERDUE loan is by definition an OLD one, so
// newest-first discarded precisely the rows the desk exists to chase. Even
// `?status=ISSUED` — which no screen sent — reached back only to 2026-01-11, so
// every book overdue since 2023, 2024 or 2025 was unreachable at any URL.
//
// The strip counted in SQL and was right all along. It was the only thing on
// the page telling the truth, and it had no list to hand you.
// =============================================================================

import { LibraryService } from "../../src/library/library.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const librarian: Principal = {
  schoolId: "A",
  userId: "lib1",
  roles: ["librarian"],
  permissions: ["library.read", "library.manage"],
};

const DAY = 86_400_000;

type Row = {
  id: string;
  bookId: string;
  borrowerId: string;
  status: string;
  issuedAt: Date;
  dueAt: Date;
  returnedAt: Date | null;
  renewedCount: number;
  fineMinor: number;
  finePaid: boolean;
  lateDaysCarried: number;
};

/**
 * Three years of lending. Every ninth loan is still out, at every age — so the
 * overdue rows are spread across the whole history and the oldest of them is
 * the furthest from a newest-first cap.
 */
function threeYears(n: number): Row[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const issued = new Date(now - (i % 1000) * DAY);
    const out = i % 9 === 0;
    return {
      id: `l${String(i).padStart(5, "0")}`,
      bookId: `b${i % 50}`,
      borrowerId: `u${i % 400}`,
      status: out ? "ISSUED" : "RETURNED",
      issuedAt: issued,
      dueAt: new Date(issued.getTime() + 14 * DAY),
      returnedAt: out ? null : new Date(issued.getTime() + 12 * DAY),
      renewedCount: 0,
      fineMinor: 0,
      finePaid: false,
      lateDaysCarried: 0,
    };
  });
}

const isOverdue = (r: Row) => r.status === "ISSUED" && r.dueAt.getTime() < Date.now();

function makeService(rows: Row[]) {
  /** The subset a `where` selects — ONE definition, so count and findMany
   *  cannot silently draw from different sets (the fixture trap that lets a
   *  service compute its total over the wrong predicate and still pass). */
  const select = (where: Record<string, unknown> = {}) =>
    rows.filter((r) => {
      if (where.borrowerId && r.borrowerId !== where.borrowerId) return false;
      if (where.status && r.status !== where.status) return false;
      const due = where.dueAt as { lt?: Date } | undefined;
      if (due?.lt && !(r.dueAt.getTime() < due.lt.getTime())) return false;
      return true;
    });

  const tx = {
    bookLoan: {
      count: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => select(where).length),
      findMany: jest.fn(
        async ({
          where,
          orderBy,
          skip = 0,
          take = 50,
        }: { where?: Record<string, unknown>; orderBy?: unknown; skip?: number; take?: number } = {}) => {
          const out = select(where);
          // Postgres returns tied rows in whatever order it likes, and
          // `Array.sort` is STABLE in V8 — a double that merely sorts cannot
          // tell a partial order from a total one. Shuffle first. (This repo
          // has been caught by exactly that three times.)
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
                  : String(av) < String(bv)
                    ? -1
                    : String(av) > String(bv)
                      ? 1
                      : 0;
              if (d !== 0) return d * (dir === "desc" ? -1 : 1);
            }
            return 0;
          });
          return out.slice(skip, skip + take);
        },
      ),
    },
    libraryBook: {
      findMany: jest.fn(async () => rows.map((r) => ({ id: r.bookId, title: `Book ${r.bookId}`, barcode: r.bookId }))),
    },
    user: { findMany: jest.fn(async () => rows.map((r) => ({ id: r.borrowerId, name: `Borrower ${r.borrowerId}` }))) },
  } as unknown as TenantTx;

  const svc = new LibraryService(
    {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    { enqueue: jest.fn() } as never,
  );
  return { svc, tx };
}

describe("a lending desk three years in", () => {
  it("SAYS HOW MANY LOANS THERE ARE, not how many fit on the screen", async () => {
    const { svc } = makeService(threeYears(12_000));
    const page = await svc.listLoans(librarian);
    expect(page.total).toBe(12_000);
    expect(page.items).toHaveLength(page.pageSize);
  });

  it("can be ASKED for the overdue rows the strip is alarming about", async () => {
    const rows = threeYears(12_000);
    const { svc } = makeService(rows);
    const page = await svc.listLoans(librarian, { overdue: true });
    // The same number the report's SQL aggregate prints beside it — the two
    // must not be able to disagree, which is the defect this file exists for.
    expect(page.total).toBe(rows.filter(isOverdue).length);
    expect(page.items.every((r) => r.overdue)).toBe(true);
  });

  it("puts the LONGEST overdue first — the queue rule, not recency", async () => {
    // A book out since 2023 is the one to chase. Under newest-first it was the
    // last row of the last page nobody could reach.
    // ONE fixture: `threeYears` is anchored on Date.now(), so building it twice
    // gives two sets of dates milliseconds apart and compares the wrong things.
    const rows = threeYears(12_000);
    const { svc } = makeService(rows);
    const page = await svc.listLoans(librarian, { overdue: true });
    const due = page.items.map((r) => new Date(r.dueAt).getTime());
    expect(due).toEqual([...due].sort((a, b) => a - b));
    expect(due[0]).toBe(Math.min(...rows.filter(isOverdue).map((r) => r.dueAt.getTime())));
  });

  it("reaches EVERY overdue row by paging, losing none and repeating none", async () => {
    const rows = threeYears(12_000);
    const { svc } = makeService(rows);
    const seen = new Set<string>();
    let n = 0;
    let page = 1;
    for (;;) {
      const out = await svc.listLoans(librarian, { overdue: true, page });
      out.items.forEach((r) => seen.add(r.id));
      n += out.items.length;
      if (page * out.pageSize >= out.total) break;
      page += 1;
      if (page > 80) break;
    }
    const expected = rows.filter(isOverdue).length;
    expect(seen.size).toBe(expected);
    // Distinct AND the same count: a partial order shows up as repeats, which a
    // Set would quietly absorb.
    expect(n).toBe(expected);
  });

  it("pages a TERM-START ISSUE where every loan shares one instant", async () => {
    // THE TIEBREAKER TEST, and it has to be built deliberately. A fixture that
    // gives each row its own day has no ties at all, so dropping `id` from the
    // ordering changes nothing and the mutation passes — which is exactly what
    // happened here on the first attempt, and is the third time this repo has
    // been caught by it. `Array.sort` is STABLE in V8 and Postgres is not.
    //
    // So: a class set issued in one transaction. Every row carries the SAME
    // `issuedAt`, and the order is decided by nothing but the tiebreaker.
    const now = Date.now();
    const rows: Row[] = Array.from({ length: 500 }, (_, i) => ({
      id: `l${String(i).padStart(5, "0")}`,
      bookId: `b${i % 50}`,
      borrowerId: `u${i}`,
      status: "RETURNED",
      issuedAt: new Date(now),
      dueAt: new Date(now + 14 * DAY),
      returnedAt: new Date(now + 12 * DAY),
      renewedCount: 0,
      fineMinor: 0,
      finePaid: false,
      lateDaysCarried: 0,
    }));
    const { svc } = makeService(rows);
    const seen = new Set<string>();
    let n = 0;
    for (let page = 1; page <= 20; page += 1) {
      const out = await svc.listLoans(librarian, { page });
      out.items.forEach((r) => seen.add(r.id));
      n += out.items.length;
      if (page * out.pageSize >= out.total) break;
    }
    // Distinct AND the same count: a partial order shows up as rows repeated on
    // one page and missing from another, and a Set alone would hide the repeat.
    expect(seen.size).toBe(500);
    expect(n).toBe(500);
  });

  it("pages the whole ledger without losing a row, though loans share a day", async () => {
    // A desk issues a class set within one second. `issuedAt` alone is a PARTIAL
    // order and offset paging over one skips and repeats.
    const rows = threeYears(600);
    const { svc } = makeService(rows);
    const seen = new Set<string>();
    for (let page = 1; page <= 20; page += 1) {
      const out = await svc.listLoans(librarian, { page });
      out.items.forEach((r) => seen.add(r.id));
      if (page * out.pageSize >= out.total) break;
    }
    expect(seen.size).toBe(600);
  });

  it("counts in the DATABASE, over the SAME predicate the page draws from", async () => {
    const { svc, tx } = makeService(threeYears(12_000));
    const count = (tx as unknown as { bookLoan: { count: jest.Mock } }).bookLoan.count;
    await svc.listLoans(librarian, { overdue: true });
    expect(count).toHaveBeenCalled();
    // The filter is IN the count, or the total describes a different population
    // than the list — a count and a list under one heading, disagreeing.
    expect(count.mock.calls[0][0].where).toMatchObject({ status: "ISSUED" });
  });

  it("still forces a non-librarian to their own loans", async () => {
    const rows = threeYears(300);
    const { svc, tx } = makeService(rows);
    const student: Principal = { schoolId: "A", userId: "u7", roles: ["student"], permissions: ["library.borrow"] };
    await svc.listLoans(student, { borrowerId: "u1" });
    const findMany = (tx as unknown as { bookLoan: { findMany: jest.Mock } }).bookLoan.findMany;
    expect(findMany.mock.calls[0][0].where).toMatchObject({ borrowerId: "u7" });
  });

  it("a small library is unchanged and complete", async () => {
    const { svc } = makeService(threeYears(20));
    const page = await svc.listLoans(librarian);
    expect(page.total).toBe(20);
    expect(page.items).toHaveLength(20);
  });
});

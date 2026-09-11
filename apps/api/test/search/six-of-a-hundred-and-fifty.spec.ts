// =============================================================================
// 150 matched, 6 were shown, and the box said nothing
// =============================================================================
// The omnibox federates four categories at six results each. Six is right for a
// jump-to; saying nothing about the remainder is not. Measured on a 1,200-pupil
// roll inside a 5,000-school fleet:
//
//     q="Adebayo"       150 matched,  6 shown
//     q="Adebayo Bola"   50 matched,  6 shown
//     q="Okonkwo"       150 matched,  6 shown
//     q="Eze"           150 matched,  6 shown
//
// A search matching 150 and a search matching exactly six rendered identically,
// so "your pupil is not on the roll" could not be told apart from "your pupil is
// one of the 144 I did not show you".
//
// And there was no ORDER BY on any of the four categories, so the six offered
// were whichever six Postgres happened to return — stable in practice and
// explicable by nothing the reader can see. The first six alphabetically is an
// answer a person can reason about; an arbitrary six is not.
//
// The cost is paid only where it buys something: every category reads
// PER_CATEGORY + 1 rows, and the ILIKE count runs ONLY when that extra row
// proves there is more. Measured: 16 ms for a search matching one pupil (no
// count), 24 ms for one matching 150 (count run).
// =============================================================================

import { SearchService } from "../../src/search/search.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const principal: Principal = {
  schoolId: "A",
  userId: "head",
  roles: ["principal"],
  permissions: ["student.profile.read", "class.read", "fee.read", "hr.read"],
};

// The staff category selects `roles` as well, so the double carries them — a
// stub missing a field the real client returns fails in a way that reads as a
// code fault.
type Row = { id: string; name: string; email: string | null; roles: Array<{ role: { name: string } }> };

/** A roll where one surname is very common — the case the cap exists for. */
const roll = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `u${String(i).padStart(4, "0")}`,
    // Deliberately NOT in alphabetical order, so a service that simply returns
    // what it was handed cannot pass the ordering assertion by luck.
    name: `Adebayo ${["Tunde", "Bola", "Ada", "Chidi", "Femi"][i % 5]}`,
    email: `p${i}@school.test`,
    roles: [{ role: { name: "student" } }],
  }));

/** Nine forms, so the class category is real and its see-all can be asserted. */
const CLASSES = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, name: `Form ${i + 1}` }));
const classMatches = (q?: string) =>
  q ? CLASSES.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())) : CLASSES;

/** The staff category is the one that excludes the student and parent roles. */
const isStaffQuery = (where?: Record<string, unknown>): boolean =>
  JSON.stringify(where ?? {}).includes("notIn");

function makeService(students: Row[]) {
  const calls = { userCount: 0, classCount: 0, invoiceCount: 0 };
  const applyOrder = (rows: Row[], orderBy: unknown): Row[] => {
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
    // Shuffle first: Postgres returns ties in whatever order it likes, and
    // `Array.sort` is stable in V8 — a double that merely sorts cannot tell a
    // partial order from a total one.
    const out = [...rows];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    out.sort((a, b) => {
      for (const k of keys) {
        const [field, dir] = Object.entries(k ?? {})[0] ?? [];
        if (!field) continue;
        const av = String(a[field as keyof Row] ?? "");
        const bv = String(b[field as keyof Row] ?? "");
        if (av !== bv) return (av < bv ? -1 : 1) * (dir === "desc" ? -1 : 1);
      }
      return 0;
    });
    return out;
  };

  const tx = {
    user: {
      // The double HONOURS the where. Both the student and the staff category
      // read `user`, and a stub that ignores the filter answers the staff query
      // with 150 pupils — which would have made "runs exactly one count" fail
      // for a reason that says nothing about the service.
      findMany: jest.fn(
        async ({ where, orderBy, take = 50 }: { where?: Record<string, unknown>; orderBy?: unknown; take?: number }) =>
          isStaffQuery(where) ? [] : applyOrder(students, orderBy).slice(0, take),
      ),
      count: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        calls.userCount += 1;
        return isStaffQuery(where) ? 0 : students.length;
      }),
    },
    class: {
      // Real rows, so the class category EXISTS and the assertion about its
      // see-all link is not vacuous. With an empty list the test guarded on
      // `if (cat)`, never fired, and a mutation inventing `/classes?q=` passed.
      findMany: jest.fn(async ({ where, take = 50 }: { where?: { name?: { contains?: string } }; take?: number } = {}) =>
        // Honours the query like the real client: a double that returns rows
        // whatever was asked makes an "it found nothing" test impossible.
        classMatches(where?.name?.contains).slice(0, take),
      ),
      count: jest.fn(async ({ where }: { where?: { name?: { contains?: string } } } = {}) => {
        calls.classCount += 1;
        return classMatches(where?.name?.contains).length;
      }),
    },
    invoice: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => {
        calls.invoiceCount += 1;
        return 0;
      }),
    },
    classSubjectTeacher: { findMany: jest.fn(async () => []) },
    enrollment: { findMany: jest.fn(async () => []) },
    parentChild: { findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;

  const svc = new SearchService({
    runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  } as never);
  return { svc, tx, calls };
}

const studentsOf = (r: { categories: Array<{ kind: string }> }) =>
  r.categories.find((c) => c.kind === "student") as
    | { kind: string; shown: number; total: number; seeAllHref: string | null }
    | undefined;

describe("an omnibox over a roll of 1,200", () => {
  it("SAYS HOW MANY MATCHED, not how many fit in the box", async () => {
    const { svc } = makeService(roll(150));
    const res = await svc.search(principal, "Adebayo");
    const cat = studentsOf(res);
    expect(cat?.shown).toBe(6);
    expect(cat?.total).toBe(150);
  });

  it("offers the first six BY NAME — an answer a person can reason about", async () => {
    const { svc } = makeService(roll(150));
    const names = (await svc.search(principal, "Adebayo")).hits
      .filter((h) => h.kind === "student")
      .map((h) => h.title);
    expect(names).toEqual([...names].sort());
    // "Ada" sorts first in the fixture, so an unordered read cannot produce this.
    expect(names[0]).toBe("Adebayo Ada");
  });

  it("answers the SAME six every time, though fifty share a name", async () => {
    // `name` alone is not a total order on a roll like this; `id` decides the
    // rest. Without it the six drift between identical queries.
    const { svc } = makeService(roll(150));
    const runs = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const ids = (await svc.search(principal, "Adebayo")).hits
        .filter((h) => h.kind === "student")
        .map((h) => h.id)
        .join("|");
      runs.add(ids);
    }
    expect(runs.size).toBe(1);
  });

  it("names WHERE THE REST ARE, with the query carried over", async () => {
    const { svc } = makeService(roll(150));
    expect(studentsOf(await svc.search(principal, "Adebayo"))?.seeAllHref).toBe("/students?q=Adebayo");
    // Encoded, or a two-word search produces a broken link.
    expect(studentsOf(await svc.search(principal, "Adebayo Bola"))?.seeAllHref).toBe(
      "/students?q=Adebayo%20Bola",
    );
  });

  it("does NOT invent a destination for a list that has no query page", async () => {
    // /classes and /fees take no `?q=`. A "see all" that leads nowhere is worse
    // than none — it promises the reader a route that does not exist.
    const { svc } = makeService(roll(10));
    // A query that matches the FORMS, so the class category is populated.
    const res = await svc.search(principal, "Form");
    const cls = res.categories.find((c) => c.kind === "class");
    // The category must BE there, or this asserts nothing — which is exactly
    // how the first version of this test let a mutation through.
    expect(cls).toBeDefined();
    expect(cls?.total).toBe(9);
    expect(cls?.seeAllHref).toBeNull();
  });
});

describe("the count is paid for only where it buys something", () => {
  it("a search whose matches all FIT runs no count at all", async () => {
    // The common search matches a handful. Nobody should pay an ILIKE count
    // over the whole roll to be told "3 of 3".
    const { svc, calls } = makeService(roll(3));
    const cat = studentsOf(await svc.search(principal, "Adebayo"));
    expect(cat?.shown).toBe(3);
    expect(cat?.total).toBe(3);
    expect(calls.userCount).toBe(0);
  });

  it("a search with more behind it runs exactly one", async () => {
    const { svc, calls } = makeService(roll(150));
    await svc.search(principal, "Adebayo");
    expect(calls.userCount).toBe(1);
  });

  it("reads one row past the page, which is how it knows", async () => {
    const { svc, tx } = makeService(roll(150));
    await svc.search(principal, "Adebayo");
    const findMany = (tx as unknown as { user: { findMany: jest.Mock } }).user.findMany;
    expect(findMany.mock.calls[0][0].take).toBe(7);
  });
});

describe("a category with nothing in it says nothing", () => {
  it("contributes no entry rather than a hollow '0 of 0'", async () => {
    const { svc } = makeService([]);
    const res = await svc.search(principal, "Zzzz");
    expect(res.hits).toEqual([]);
    expect(res.categories).toEqual([]);
  });

  it("a query too short to search returns the empty shape, not undefined", async () => {
    const { svc } = makeService(roll(150));
    const res = await svc.search(principal, "a");
    expect(res.hits).toEqual([]);
    expect(res.categories).toEqual([]);
  });
});

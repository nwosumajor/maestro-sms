// =============================================================================
// 600 alumni, 500 shown, and the ones that vanished were the oldest
// =============================================================================
// `AlumniService.list` was `take: 500`, ordered newest-cohort-first, with no
// page and no total — on the ONE table in this product that only ever grows. A
// school adds a whole cohort every year and nobody stops being an alumnus.
//
// The broadcast in the same file says exactly that, and counts in the database
// because of it:
//
//     "An alumni roll only ever grows — nobody stops being an alumnus — so
//      hydrating every row to answer a question about three numbers is exactly
//      the 'count in the database, never findMany().length' rule..."
//
// The careful half was written; the list beside it was capped and silent.
//
// Measured on a school with three real cohorts of 200:
//
//     holds 600, the list returned 500, as a bare array — no total, no page
//
// And because it reads newest-first, the 100 that fell off were the class of
// 2024: the OLDEST cohort, which for alumni is precisely backwards — the
// established years are the ones a school wants for a reunion or an appeal. At
// ten years the default view would show a quarter of the register and say
// nothing about the rest.
//
// The broadcast was NOT affected and is left alone: driven on the same school it
// reported `{queued: 501, unreachable: 99, noEmail: 99}` — 600 accounted for.
// =============================================================================

import { AlumniService } from "../../src/alumni/alumni.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const registrar: Principal = {
  schoolId: "A",
  userId: "reg",
  roles: ["school_admin"],
  permissions: ["alumni.manage"],
};

type Row = { id: string; schoolId: string; name: string; email: string | null; graduationYear: number };

/** Three cohorts, newest year first when ordered — as a real register is. */
const cohorts = (perYear: number, years = [2026, 2025, 2024]): Row[] =>
  years.flatMap((graduationYear, yi) =>
    Array.from({ length: perYear }, (_, i) => ({
      id: `al-${yi}-${String(i).padStart(4, "0")}`,
      schoolId: "A",
      name: `Alum ${String(i).padStart(4, "0")}`,
      email: i % 6 === 0 ? null : `a${i}.${graduationYear}@x.test`,
      graduationYear,
    })),
  );

function makeService(rows: Row[]) {
  const tx = {
    alumnus: {
      findMany: jest.fn(async ({ where, orderBy, skip = 0, take = 50 }: {
        where?: Record<string, unknown>; orderBy?: unknown; skip?: number; take?: number;
      }) => {
        let out = rows.filter((r) => (where?.graduationYear ? r.graduationYear === where.graduationYear : true));
        // TIED ROWS COME BACK ARBITRARILY, as they do in Postgres.
        //
        // `Array.prototype.sort` is STABLE in V8, so a double that merely sorts
        // returns the same sequence for a partial order as for a total one —
        // and the paging test passes with the tiebreaker removed, proving
        // nothing. Third time this has been hit in this repo; shuffling first
        // is what makes a partial order behave like the database's.
        out = [...out];
        for (let i = out.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [out[i], out[j]] = [out[j], out[i]];
        }
        const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
        out = [...out].sort((a, b) => {
          for (const k of keys) {
            const [field, dir] = Object.entries(k ?? {})[0] ?? [];
            if (!field) continue;
            const av = a[field as keyof Row];
            const bv = b[field as keyof Row];
            const d = typeof av === "number" && typeof bv === "number"
              ? av - bv
              : String(av ?? "") < String(bv ?? "") ? -1 : String(av ?? "") > String(bv ?? "") ? 1 : 0;
            if (d !== 0) return d * (dir === "desc" ? -1 : 1);
          }
          return 0;
        });
        return out.slice(skip, skip + take);
      }),
      count: jest.fn(async ({ where }: { where?: Record<string, unknown> }) =>
        rows.filter((r) => (where?.graduationYear ? r.graduationYear === where.graduationYear : true)).length,
      ),
    },
  } as unknown as TenantTx;
  const svc = new AlumniService(
    {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    { send: jest.fn(), isConfigured: () => false } as never,
    { add: jest.fn() } as never,
  );
  return { svc, tx };
}

describe("a school's alumni register", () => {
  it("SAYS HOW MANY THERE ARE, so a page cannot read as the whole roll", async () => {
    const { svc } = makeService(cohorts(200));
    const out = await svc.list(registrar);
    expect(out.total).toBe(600);
    expect(out.items).toHaveLength(out.pageSize);
    expect(out.page).toBe(1);
  });

  it("reaches the OLDEST cohort, which the cap used to drop", async () => {
    // Newest-first ordering meant the class of 2024 fell off the end. Those are
    // the established years — the ones a reunion or an appeal is aimed at.
    const { svc } = makeService(cohorts(200));
    const seen = new Set<string>();
    const years = new Set<number>();
    const pages = Math.ceil(600 / (await svc.list(registrar)).pageSize);
    for (let page = 1; page <= pages; page += 1) {
      const out = await svc.list(registrar, { page });
      out.items.forEach((a) => {
        seen.add(a.id);
        if (a.graduationYear) years.add(a.graduationYear);
      });
    }
    expect(seen.size).toBe(600);
    expect([...years].sort()).toEqual([2024, 2025, 2026]);
  });

  it("pages without losing a row, though alumni share a name and a year", async () => {
    // Two people in one cohort can share a name; `graduationYear, name` alone is
    // not a total order, and offset paging over a partial one skips and repeats.
    const rows = cohorts(120).map((r, i) => ({ ...r, name: `Same Name ${i % 3}` }));
    const { svc } = makeService(rows);
    const seen = new Set<string>();
    for (let page = 1; page <= 10; page += 1) {
      const out = await svc.list(registrar, { page });
      out.items.forEach((a) => seen.add(a.id));
      if (page * out.pageSize >= out.total) break;
    }
    expect(seen.size).toBe(rows.length);
  });

  it("a small school is unchanged and complete", async () => {
    const { svc } = makeService(cohorts(10));
    const out = await svc.list(registrar);
    expect(out.total).toBe(30);
    expect(out.items).toHaveLength(30);
  });

  it("counts the FILTER, not the whole roll, when a cohort is asked for", async () => {
    const { svc } = makeService(cohorts(200));
    const out = await svc.list(registrar, { year: 2024 });
    expect(out.total).toBe(200);
    expect(out.items.every((a) => a.graduationYear === 2024)).toBe(true);
  });

  it("counts in the DATABASE rather than measuring the page it fetched", async () => {
    const { svc, tx } = makeService(cohorts(200));
    await svc.list(registrar);
    expect((tx as unknown as { alumnus: { count: jest.Mock } }).alumnus.count).toHaveBeenCalled();
  });
});

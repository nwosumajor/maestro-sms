// =============================================================================
// The public front door shipped the whole platform
// =============================================================================
// `GET /public/schools` returned EVERY active school — unpaged, unsearchable, on
// an endpoint anybody on the internet can call — and `/schools` rendered all of
// them. Measured against the running app at 5,003 schools:
//
//     678,197 bytes   5,003 rows   631 ms median render (the slowest page,
//                                  by an order of magnitude)
//
// It grows linearly with the fleet: at 50,000 schools that is ~6.8 MB a call.
// The route's own comment CONCEDED the shape — "an unlimited caller drives a
// findMany over every ACTIVE school on every request" — and answered it with a
// rate limit, which bounds how OFTEN the cost is paid, not the cost. 60 calls a
// minute of 678 KB is 40 MB a minute, per IP, unauthenticated.
//
// And it was the wrong PRODUCT at that size before it was a performance problem:
// nobody finds their child's school by scrolling five thousand names. So the fix
// is the one this repo has made before for the library catalogue, the discipline
// picker and /exams — the control the reader uses has to reach past the cap, so
// the search runs in SQL and the total says what is not shown.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_SCHOOL_PAGE_SIZE } from "@sms/types";
import { stripComments } from "../support/strip-comments";
import { PublicService } from "../../src/public/public.service";

const SRC = stripComments(
  readFileSync(join(__dirname, "..", "..", "src", "public", "public.service.ts"), "utf8"),
);

/** A fleet of `n` schools, answering `findMany`/`count` the way Postgres would. */
function makeService(n: number) {
  const all = Array.from({ length: n }, (_, i) => ({
    id: `s-${i}`, name: `School ${String(i).padStart(5, "0")}`, slug: `school-${i}`,
    admissionFormFeeMinor: 0, currency: "NGN",
  }));
  // HONOURS EVERY PREDICATE THE SERVICE USES — the name search AND the slug
  // filter. The first draft handled only `name`, so the by-slug read came back
  // with all 5,003 schools and the test failed for a fault in itself. A double
  // must model the CONTRACT, not the call it was written for.
  const match = (where: Record<string, unknown>) => {
    let rows = all;
    const nameF = where.name as { contains?: string } | undefined;
    if (nameF?.contains) {
      const needle = nameF.contains.toLowerCase();
      rows = rows.filter((s) => s.name.toLowerCase().includes(needle));
    }
    const slugF = where.slug as { in?: string[] } | undefined;
    if (slugF?.in) rows = rows.filter((s) => slugF.in!.includes(s.slug));
    return rows;
  };
  const tx = {
    school: {
      // HONOURS take/skip AND the name filter. A stub that ignored them would
      // pass against the very service this exists to prevent.
      findMany: jest.fn(async (a: { where: Record<string, unknown>; skip?: number; take?: number }) => {
        const m = match(a.where);
        return m.slice(a.skip ?? 0, (a.skip ?? 0) + (a.take ?? m.length));
      }),
      count: jest.fn(async (a: { where: Record<string, unknown> }) => match(a.where).length),
    },
  };
  const db = { runAsTenant: <T,>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx) };
  const svc = new PublicService(db as never, { record: jest.fn() } as never, {} as never, {} as never, {} as never);
  return { svc, tx };
}

describe("the public directory is bounded", () => {
  it("returns ONE page, whatever the size of the fleet", async () => {
    const { svc } = makeService(5003);
    const r = await svc.listSchools();
    expect(r.items).toHaveLength(PUBLIC_SCHOOL_PAGE_SIZE);
  });

  it("says how many there ARE, so a page is not read as the whole directory", async () => {
    const { svc } = makeService(5003);
    expect((await svc.listSchools()).total).toBe(5003);
  });

  it("searches in the DATABASE, so the reader can reach past the page", async () => {
    // The defect this half exists for: a control that only filters the loaded
    // page cannot find a school that sorts after it.
    const { svc, tx } = makeService(5003);
    const r = await svc.listSchools({ q: "School 04999" });
    expect(r.items.map((s) => s.slug)).toEqual(["school-4999"]);
    const where = (tx.school.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.name).toMatchObject({ contains: "School 04999" });
  });

  it("counts over the SAME predicate the page is drawn from", async () => {
    // A total the caller cannot reconcile with the list in front of them is
    // worse than no total.
    const { svc } = makeService(5003);
    const r = await svc.listSchools({ q: "School 0499" });
    expect(r.total).toBe(r.items.length);
    expect(r.total).toBeLessThan(5003);
  });

  it("pages, so a school that sorts late is still reachable", async () => {
    const { svc } = makeService(5003);
    const p2 = await svc.listSchools({ page: 2 });
    expect(p2.items[0].slug).toBe(`school-${PUBLIC_SCHOOL_PAGE_SIZE}`);
    expect(p2.page).toBe(2);
  });

  it("keeps the public shape public — and no wider", async () => {
    // Widening the REACH must not widen what is exposed. These four fields are
    // the ones a family needs before applying; nothing else may join them.
    const { svc } = makeService(3);
    const [one] = (await svc.listSchools()).items;
    expect(Object.keys(one).sort()).toEqual(
      ["admissionFormFeeMinor", "currency", "id", "name", "slug"].sort(),
    );
  });

  it("never asks the database for an unbounded page", () => {
    // The durable half: `take` is not optional here. A future edit that drops it
    // restores a 678 KB public response with every test above still green,
    // because the stub would happily return everything.
    expect(SRC).toMatch(/take:\s*pageSize/);
    expect(SRC).toMatch(/skip:\s*\(page - 1\) \* pageSize/);
  });
});

describe("choosing is a different question from browsing", () => {
  it("resolves chosen schools BY SLUG, bounded so it cannot walk the fleet", async () => {
    const { svc } = makeService(5003);
    const got = await svc.schoolsBySlugs(["school-1", "school-2", "school-1"]);
    expect(got.map((s) => s.slug).sort()).toEqual(["school-1", "school-2"]);
  });

  it("caps how many slugs one call may resolve", async () => {
    const { svc, tx } = makeService(5003);
    await svc.schoolsBySlugs(Array.from({ length: 500 }, (_, i) => `school-${i}`));
    const where = (tx.school.findMany as jest.Mock).mock.calls[0][0].where;
    expect((where.slug.in as string[]).length).toBeLessThanOrEqual(20);
  });

  it("returns nothing for no slugs, rather than everything", async () => {
    // The failure mode worth naming: an empty filter that means "all".
    const { svc, tx } = makeService(5003);
    expect(await svc.schoolsBySlugs([])).toEqual([]);
    expect(tx.school.findMany).not.toHaveBeenCalled();
  });
});

describe("every route on the PUBLIC controller is reachable by the public", () => {
  // The defect this exists for, made and caught within the hour: the new
  // `schools/by-slug` route was added WITHOUT `@Public()`, so the auth guard
  // answered 401 — and the only symptom was that a school's own enrolment link
  // silently stopped preselecting it. A controller whose whole purpose is the
  // unauthenticated surface should not have a route that quietly is not.
  const CONTROLLER = stripComments(
    readFileSync(join(__dirname, "..", "..", "src", "public", "public.controller.ts"), "utf8"),
  );

  it("marks every @Get/@Post with @Public()", () => {
    // Walk the decorators in source order: every route decorator must have a
    // `@Public()` somewhere in the block above it, before the previous route.
    const lines = CONTROLLER.split("\n");
    const offenders: string[] = [];
    let sawPublic = false;
    for (const line of lines) {
      if (/@Public\(\)/.test(line)) sawPublic = true;
      const route = line.match(/@(Get|Post|Put|Patch|Delete)\(([^)]*)\)/);
      if (route) {
        if (!sawPublic) offenders.push(`${route[1]} ${route[2] || "(root)"}`);
        sawPublic = false;
      }
    }
    expect(offenders).toEqual([]);
  });

  it("found a believable number of routes", () => {
    // A walk that matches nothing produces no offenders and passes green.
    const n = [...CONTROLLER.matchAll(/@(Get|Post|Put|Patch|Delete)\(/g)].length;
    expect(n).toBeGreaterThan(5);
  });
});

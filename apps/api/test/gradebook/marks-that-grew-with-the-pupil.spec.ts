// =============================================================================
// A read bounded by how long the pupil has been at the school
// =============================================================================
// `listMyGrades` read EVERY submission the pupil had ever made, fed those ids
// back as an `IN` list, and returned every published grade against them — no
// page, no cap, no period. A parent's view unions their children, so a family
// multiplies it.
//
// Measured on a fleet aged three years, one pupil with a realistic record:
//
//     a pupil, 3 years in            810 marks    277 KB    59 ms
//     a parent of three, 3 years in  2,430 marks  831 KB   116 ms
//
// Nothing was dropped — there is no cap to drop anything — so it degrades
// invisibly, which is what makes an O(lifetime) read the shape it is. At six
// years that parent fetches 1.7 MB to look at this week's marks.
//
// AND THE SCREEN ALREADY CLAIMED A PERIOD. `MyMarks` renders "Nothing has been
// marked yet this term" over a list that was all-time, so a pupil three years
// in saw three years of work under a heading about this term.
//
// So the period is real now: the school's CURRENT term by default, any term on
// request, paged within it — and the terms are returned so nothing earlier
// becomes unreachable. Bounding a read is only honest if the rest is still
// somewhere.
// =============================================================================

import { GradebookService } from "../../src/gradebook/gradebook.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

type Grade = { id: string; submissionId: string; studentId: string; termId: string | null; gradedAt: Date };

const TERMS = [
  { id: "t3", name: "Third Term", isCurrent: true, startDate: new Date("2026-05-01") },
  { id: "t2", name: "Second Term", isCurrent: false, startDate: new Date("2026-01-01") },
  { id: "t1", name: "First Term", isCurrent: false, startDate: new Date("2025-09-01") },
];

/**
 * The tx double models the CONTRACT: grades are filtered through the submission
 * relation (student AND the assessment's term), ordered, and paged. A double
 * that ignored the `where` would pass against a service that had stopped
 * filtering, which is the defect.
 */
function makeService(grades: Grade[], children: string[] = []) {
  const matches = (g: Grade, where: Record<string, unknown>) => {
    const sub = (where.submission ?? {}) as {
      studentId?: { in: string[] };
      assessment?: { OR?: Array<{ termId: string | null }> };
    };
    if (sub.studentId?.in && !sub.studentId.in.includes(g.studentId)) return false;
    if (sub.assessment?.OR) {
      const wanted = sub.assessment.OR.map((o) => o.termId);
      if (!wanted.includes(g.termId)) return false;
    }
    return true;
  };
  const tx = {
    parentChild: { findMany: jest.fn(async () => children.map((studentId) => ({ studentId }))) },
    term: { findMany: jest.fn(async () => TERMS) },
    grade: {
      findMany: jest.fn(async ({ where, skip = 0, take = 50, orderBy }: Record<string, never> & {
        where: Record<string, unknown>; skip?: number; take?: number; orderBy?: unknown;
      }) => {
        const hit = grades.filter((g) => matches(g, where));
        // TIED ROWS COME BACK IN AN ARBITRARY ORDER, as they do in Postgres.
        //
        // `Array.prototype.sort` is STABLE in V8, so a double that simply
        // sorted would hand back the same sequence for a partial order as for a
        // total one — and the paging test passed with the tiebreaker removed,
        // proving nothing about the property it names. Shuffling first is what
        // makes a partial order behave like the database's.
        for (let i = hit.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [hit[i], hit[j]] = [hit[j], hit[i]];
        }
        const keys = Array.isArray(orderBy) ? orderBy : [orderBy];
        hit.sort((a, b) => {
          for (const k of keys as Array<Record<string, "asc" | "desc">>) {
            const [field, dir] = Object.entries(k ?? {})[0] ?? [];
            if (!field) continue;
            const av = String(a[field as keyof Grade] ?? "");
            const bv = String(b[field as keyof Grade] ?? "");
            if (av !== bv) return (av < bv ? -1 : 1) * (dir === "desc" ? -1 : 1);
          }
          return 0;
        });
        return hit.slice(skip, skip + take);
      }),
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        grades.filter((g) => matches(g, where)).length,
      ),
    },
  } as unknown as TenantTx;
  const svc = new GradebookService(
    { runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) } as never,
    { record: jest.fn() } as never,
  );
  return { svc, tx };
}

const pupil: Principal = { schoolId: "A", userId: "kid", roles: ["student"], permissions: ["grade.read"] };
const parent: Principal = { schoolId: "A", userId: "mum", roles: ["parent"], permissions: ["grade.read"] };

/** Three years of marks: 60 per term across the nine terms, all tied on time. */
const threeYears = (studentId: string): Grade[] =>
  TERMS.flatMap((t) =>
    Array.from({ length: 60 }, (_, i) => ({
      id: `${studentId}-${t.id}-${String(i).padStart(3, "0")}`,
      submissionId: `s-${studentId}-${t.id}-${i}`,
      studentId,
      termId: t.id,
      // EVERY row in a term shares an instant — a teacher marks a set at once,
      // and that is what makes `gradedAt` alone a partial order.
      gradedAt: new Date("2026-06-01T10:00:00Z"),
    })),
  );

describe("a pupil's marks are one term's, not a lifetime's", () => {
  it("defaults to the school's CURRENT term and says which", async () => {
    const { svc } = makeService(threeYears("kid"));
    const page = await svc.listMyGrades(pupil);
    expect(page).toMatchObject({ termId: "t3", termName: "Third Term", total: 60 });
    expect(page.items).toHaveLength(50);
  });

  it("offers the other terms, so earlier work is still reachable", async () => {
    const { svc } = makeService(threeYears("kid"));
    const page = await svc.listMyGrades(pupil);
    expect(page.terms.map((t) => t.name)).toEqual(["Third Term", "Second Term", "First Term"]);
    const older = await svc.listMyGrades(pupil, { termId: "t1" });
    expect(older).toMatchObject({ termId: "t1", termName: "First Term", total: 60 });
  });

  it("PAGES WITHOUT LOSING A ROW, though every mark shares one instant", async () => {
    // Offset paging over a partial order lets tied rows come back in a
    // different order per page, silently skipping some and repeating others.
    // Driven live before the tiebreaker: a parent of three with 270 marks in a
    // term paged six pages and saw 239 distinct rows, with nothing saying 31
    // were missing.
    const { svc } = makeService(threeYears("kid"));
    const seen = new Set<string>();
    let page = 1;
    let total = 0;
    for (;;) {
      const p = await svc.listMyGrades(pupil, { page });
      total = p.total;
      p.items.forEach((i) => seen.add(i.id));
      if (page * p.pageSize >= p.total) break;
      page += 1;
      if (page > 20) break;
    }
    expect(seen.size).toBe(total);
    expect(total).toBe(60);
  });

  it("a PARENT sees their children's marks, still bounded by the term", async () => {
    const { svc } = makeService(
      [...threeYears("kid-a"), ...threeYears("kid-b"), ...threeYears("kid-c")],
      ["kid-a", "kid-b", "kid-c"],
    );
    const page = await svc.listMyGrades(parent);
    // Three children x 60 in the term — not three years x three children.
    expect(page.total).toBe(180);
    expect(page.items).toHaveLength(50);
  });

  it("and NOT another family's child", async () => {
    const { svc } = makeService([...threeYears("kid-a"), ...threeYears("someone-else")], ["kid-a"]);
    expect((await svc.listMyGrades(parent)).total).toBe(60);
  });

  it("includes UNTAGGED work in every term — a school part-way through tagging keeps its history", async () => {
    // The same fail-open the report card takes: an assessment with no term must
    // not make a pupil's mark vanish from every view. Each row carries its own
    // date, so the reader can still place it.
    const { svc } = makeService([
      ...threeYears("kid"),
      { id: "legacy", submissionId: "s-legacy", studentId: "kid", termId: null, gradedAt: new Date("2024-01-01") },
    ]);
    expect((await svc.listMyGrades(pupil)).total).toBe(61);
    expect((await svc.listMyGrades(pupil, { termId: "t1" })).total).toBe(61);
  });

  it("REFUSES a term this school does not have, rather than widening to everything", async () => {
    // A filter the caller cannot satisfy is refused, never answered with more
    // data than they asked for.
    const { svc } = makeService(threeYears("kid"));
    await expect(svc.listMyGrades(pupil, { termId: "someone-elses-term" })).rejects.toThrow(/term not found/i);
  });

  it("never asks for every submission the pupil ever made", async () => {
    // The old shape: read all submission ids, then pass them back as an `IN`
    // list. That list is what grew with the pupil's time at the school.
    const { svc, tx } = makeService(threeYears("kid"));
    await svc.listMyGrades(pupil);
    expect((tx as unknown as { submission?: unknown }).submission).toBeUndefined();
    const where = (tx as unknown as { grade: { findMany: jest.Mock } }).grade.findMany.mock.calls[0][0].where;
    expect(where.submission.studentId.in).toEqual(["kid"]);
    expect(JSON.stringify(where)).not.toMatch(/submissionId/);
  });
});

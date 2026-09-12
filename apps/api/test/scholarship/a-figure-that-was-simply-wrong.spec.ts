// =============================================================================
// "Awarded: 29" on a school that had awarded 60
// =============================================================================
// `listForSchool` is leadership's oversight list, and its docstring says "every
// application raised in THEIR OWN school". It returned the newest 500 with no
// count and no filter — and the panel then computed its HEADLINE FIGURES from
// that array:
//
//     { label: "Submitted",   value: applications.length }
//     { label: "In progress", value: open.length }
//     { label: "Awarded",     value: awarded.length }
//
// Measured live on a five-year school holding 1,200 applications (20 platform
// rounds x 60 applicants, awards clustered in the early years as they would be):
//
//                    shown    true
//     Submitted        500    1200
//     In progress      405     980
//     Awarded           29      60
//     covered     2024-09-24 .. 2026-09-15   (first 2.5 years unreachable)
//
// More than half the school's scholarships were missing from the awarded
// figure. This is a step past the capped lists elsewhere in this log: a wrong
// NUMBER on an oversight screen is worse than a short list, because nothing
// about it looks short. Leadership reads "29" and has no reason to doubt it.
//
// The counts are now a groupBy over every non-DRAFT application, deliberately
// NOT narrowed by the status filter or the page — otherwise filtering to awards
// would report that nothing is in progress.
// =============================================================================

import { ScholarshipService } from "../../src/scholarship/scholarship.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const head: Principal = {
  schoolId: "A", userId: "head", roles: ["principal"],
  permissions: ["scholarship.read"],
};

/** 1,200 applications over five years; 60 AWARDED, clustered in the early ones. */
const APPS = Array.from({ length: 1200 }, (_, i) => ({
  id: `app-${String(i).padStart(4, "0")}`,
  schoolId: "A",
  programId: `prog-${Math.floor(i / 60)}`,
  studentId: `stu-${i % 60}`,
  applicantId: "parent-1",
  applicantRole: "PARENT",
  status: i % 20 === 0 ? "AWARDED" : i % 7 === 0 ? "REJECTED" : i % 5 === 0 ? "PENDING_PRINCIPAL" : "SUBMITTED",
  awardMinor: i % 20 === 0 ? 5_000_000 : null,
  answers: null, signals: null, consentById: null, consentAt: null,
  reviewedById: null, reviewNote: null, disbursementPaymentId: null,
  // OLDEST first in index order, so a newest-first cap drops the early years.
  createdAt: new Date(Date.now() - (1200 - i) * 86_400_000),
  updatedAt: new Date(),
}));
const DRAFTS = Array.from({ length: 40 }, (_, i) => ({
  ...APPS[0], id: `draft-${i}`, status: "DRAFT",
}));

function makeService(rows = [...APPS, ...DRAFTS]) {
  const match = (where: Record<string, unknown> = {}) => {
    const st = where.status as string | { not?: string } | undefined;
    return rows.filter((r) => {
      if (typeof st === "string") return r.status === st;
      if (st && typeof st === "object" && st.not) return r.status !== st.not;
      return true;
    });
  };
  const tx = {
    scholarshipApplication: {
      findMany: jest.fn(async ({ where, take, skip }: Record<string, never>) => {
        const out = [...match(where)].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1),
        );
        const from = (skip as number) ?? 0;
        return out.slice(from, from + ((take as number) ?? out.length));
      }),
      count: jest.fn(async ({ where }: Record<string, never>) => match(where).length),
      // Grouped over whatever predicate it is GIVEN — a double that always
      // grouped over everything would hide a service grouping the wrong set.
      groupBy: jest.fn(async ({ where }: Record<string, never>) => {
        const by = new Map<string, number>();
        for (const r of match(where)) by.set(r.status, (by.get(r.status) ?? 0) + 1);
        return [...by].map(([status, n]) => ({ status, _count: { _all: n } }));
      }),
    },
    scholarshipProgram: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;

  const svc = new ScholarshipService(
    {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn(), notifyPermissionHolders: jest.fn() } as never,
    { forSchool: jest.fn(async () => ({ timezone: "Africa/Lagos", currency: "NGN" })), inTx: jest.fn(async () => ({ timezone: "Africa/Lagos" })) } as never,
    { getSitting: jest.fn(), startSitting: jest.fn(), answer: jest.fn(), submit: jest.fn(), answerTheory: jest.fn(), recordIntegrityEvents: jest.fn() } as never,
  );
  return { svc, tx };
}

describe("the figures leadership is shown are the school's, not the page's", () => {
  it("counts every AWARD, not the ones that fit the page", async () => {
    const { svc } = makeService();
    const r = await svc.listForSchool(head);
    expect(r.items.length).toBeLessThan(1200);
    // The defect, as a number: 29 shown against 60 held.
    expect(r.counts.AWARDED).toBe(60);
  });

  it("counts every submitted application", async () => {
    const { svc } = makeService();
    const r = await svc.listForSchool(head);
    const submitted = Object.values(r.counts).reduce((a, b) => a + b, 0);
    expect(submitted).toBe(1200);
    expect(r.total).toBe(1200);
  });

  it("EXCLUDES drafts from the figures, as the oversight rule says", async () => {
    // A draft belongs to whoever is writing it; counting it would tell
    // leadership about a form nobody has submitted.
    const { svc } = makeService();
    const r = await svc.listForSchool(head);
    expect(r.counts.DRAFT).toBe(0);
    expect(r.total).toBe(1200);
  });

  it("keeps the figures whole when a FILTER is applied", async () => {
    // Otherwise filtering to awards reports that nothing is in progress.
    const { svc } = makeService();
    const r = await svc.listForSchool(head, { status: "AWARDED" });
    expect(r.total).toBe(60);
    expect(r.items.every((a) => a.status === "AWARDED")).toBe(true);
    expect(r.counts.AWARDED).toBe(60);
    expect(r.counts.SUBMITTED).toBeGreaterThan(0);
  });

  it("filters in the DATABASE, not over the page it already fetched", async () => {
    const { svc, tx } = makeService();
    await svc.listForSchool(head, { status: "AWARDED" });
    const calls = (tx as unknown as { scholarshipApplication: { findMany: jest.Mock } }).scholarshipApplication.findMany.mock.calls;
    expect(JSON.stringify(calls[0][0].where)).toMatch(/AWARDED/);
  });

  it("reaches the early years BY PAGE — the 700 with no route", async () => {
    const { svc } = makeService();
    const first = await svc.listForSchool(head);
    const deep = await svc.listForSchool(head, { page: 3 });
    expect(deep.items.length).toBeGreaterThan(0);
    expect(deep.items[0].id).not.toBe(first.items[0].id);
    expect(deep.page).toBe(3);
  });

  it("pages the whole record without skipping or repeating one", async () => {
    const { svc } = makeService();
    const seen = new Set<string>();
    for (let page = 1; page <= 3; page += 1) {
      const r = await svc.listForSchool(head, { page });
      for (const a of r.items) seen.add(a.id);
    }
    expect(seen.size).toBe(1200);
  });

  it("a school in its first term is unchanged and complete", async () => {
    const { svc } = makeService(APPS.slice(0, 12));
    const r = await svc.listForSchool(head);
    expect(r.total).toBe(12);
    expect(r.items).toHaveLength(12);
  });
});

// =============================================================================
// The oldest undecided application must still be reachable
// =============================================================================
// `list` was `findMany({ orderBy: { createdAt: "desc" }, take: 200 })` with no
// filter, no paging and no total, on a permanent table (the app role has no
// DELETE on `admission_application`). An application that is still NEW or
// REVIEWING is one nobody has answered — it AGES — and ordering newest-first
// drops the oldest off the end, so the family that applied FIRST was the one
// the screen could not show. There was no status filter at all, so "what is
// still waiting on us" had no answer short of reading every card.
//
// The page's own comment already said "a family waiting on a decision is the
// cost". That reasoning had been applied to a failed read and never to the cap.
//
// Same class as the chargeback banner and, before it, approvals / leave /
// assessments: filtering in memory still only ever sees the rows that survived
// the cap.
// =============================================================================

import { AdmissionsService } from "../../src/admissions/admissions.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

type Args = Record<string, unknown>;

function makeService() {
  const seen: { findMany: Args[]; count: Args[] } = { findMany: [], count: [] };
  const tx = {
    admissionApplication: {
      findMany: jest.fn((a: Args) => {
        seen.findMany.push(a);
        return Promise.resolve([]);
      }),
      count: jest.fn((a: Args) => {
        seen.count.push(a);
        return Promise.resolve(7);
      }),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const service = new AdmissionsService(
    db as never,
    { record: jest.fn() } as never,
    { deliver: jest.fn() } as never,
    { isConfigured: () => false } as never,
    { effective: jest.fn() } as never,
    { client: null } as never,
    { forSchool: jest.fn() } as never,
    { promoteApplicationInTx: jest.fn() } as never,
  );
  return { service, seen };
}

const officer: Principal = {
  schoolId: "A",
  userId: "adm-1",
  roles: ["school_admin"],
  permissions: ["admission.review"],
};

describe("the admissions list is a record, not a queue", () => {
  it("pages instead of truncating, and reports the matching total", async () => {
    const { service, seen } = makeService();
    const res = await service.list(officer, { page: 3 });
    const q = seen.findMany[0];
    expect(q.take).toBe(res.pageSize);
    expect(q.skip).toBe((3 - 1) * res.pageSize);
    // `total` is what MATCHES, so the page can say what it is showing out of
    // what there is. A cap with no total reads as the complete answer.
    expect(res.total).toBe(7);
    expect(res.page).toBe(3);
  });

  it("filters in SQL — a filter must narrow the query, never a page of results", async () => {
    const { service, seen } = makeService();
    await service.list(officer, { status: "NEW", q: "Ada" });
    const where = seen.findMany[0].where as Args;
    expect(where.status).toBe("NEW");
    // The needle reaches the columns a family is actually looked up by.
    const or = JSON.stringify(where.OR);
    for (const field of ["childName", "applicantName", "applicantEmail"]) {
      expect([field, or.includes(field)]).toEqual([field, true]);
    }
    expect(or).toContain("insensitive");
  });

  it("counts the undecided school-wide, so a filter cannot hide a waiting family", async () => {
    const { service, seen } = makeService();
    await service.list(officer, { status: "ACCEPTED", q: "Ada" });
    // Two counts: the filtered total, and the undecided one. The undecided count
    // must carry NEITHER the status filter nor the search — it answers "is a
    // family still waiting", not "how many did I just search for". A count a
    // search can change is a count a search can hide.
    const undecided = seen.count.find(
      (c) => JSON.stringify(c.where).includes("REVIEWING"),
    );
    expect(undecided).toBeDefined();
    const where = undecided!.where as Args;
    expect(where.OR).toBeUndefined();
    expect(where.status).toEqual({ in: ["NEW", "REVIEWING"] });
  });

  it("still orders newest-first, so the default screen is the current intake", async () => {
    const { service, seen } = makeService();
    await service.list(officer);
    expect(seen.findMany[0].orderBy).toEqual({ createdAt: "desc" });
    // ...and with no filter, the query carries no stray narrowing.
    expect(seen.findMany[0].where).toEqual({});
  });
});

// =============================================================================
// A leave register that stopped a year ago
// =============================================================================
// The school-wide leave list returned the 500 most recent requests, unfiltered
// and unpaged, on the reasoning in the cap's own note: an approver "only ever
// surfaces the most-recent page".
//
// But this list is also the RECORD. It is what a school reads to answer "was
// she on approved leave that week" — for payroll, for a dispute, for a cover
// arrangement — and that question is asked about last year as often as this
// one. A 60-staff school generates roughly 500 requests a year, so its own
// history fell off the end.
//
// Measured against the running stack with 800 requests:
//
//     returned          500
//     oldest reachable  2025-04-07
//     /hr page          621 KB
//
// The other 300 existed in the database and could not be reached by any means
// the product offered.
//
// `from`/`to` are an OVERLAP, matching the coverage calendar: leave from 28
// March to 2 April IS leave taken in March, and a filter that missed it would
// answer "nobody was off" — the confident wrong answer, which is worse here
// than no answer at all.
// =============================================================================

import { LeaveService } from "../../src/hr/leave.service";
import { LEAVE_PAGE_SIZE, SEARCH_CAP } from "@sms/types";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `l${i}`,
  leaveTypeId: "t1",
  userId: "u1",
  startDate: new Date("2025-03-28"),
  endDate: new Date("2025-04-02"),
  days: 2,
  reason: null,
  status: "APPROVED",
  workflowRequestId: null,
  attachmentDocId: null,
  createdAt: new Date(),
  ...over,
});

function makeService(rows: Array<Record<string, unknown>>, people: Array<{ id: string }> = []) {
  const findMany = jest.fn().mockImplementation(({ skip = 0, take = rows.length }) =>
    Promise.resolve(rows.slice(skip, skip + take)),
  );
  const count = jest.fn().mockResolvedValue(rows.length);
  const userFindMany = jest.fn().mockResolvedValue(people);
  const tx = {
    leaveRequest: { findMany, count },
    leaveType: { findMany: jest.fn().mockResolvedValue([{ id: "t1", name: "Annual" }]) },
    user: { findMany: userFindMany },
  } as unknown as TenantTx;
  const db = { runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  return {
    service: new LeaveService(db as never, {} as never, {} as never, {} as never),
    findMany,
    count,
    userFindMany,
    where: () => findMany.mock.calls[0][0].where as Record<string, unknown>,
  };
}

const hr: Principal = { schoolId: "A", userId: "hr", roles: [], permissions: ["hr.leave.manage"] };

describe("reading leave that is not recent", () => {
  it("returns a PAGE and says how many match", async () => {
    const { service } = makeService(Array.from({ length: 800 }, (_, i) => row(i)));
    const res = await service.listRegister(hr, {});
    expect(res.items).toHaveLength(LEAVE_PAGE_SIZE);
    expect(res.total).toBe(800);
  });

  it("pages into last year instead of stopping at the most recent", async () => {
    const { service, findMany } = makeService(Array.from({ length: 800 }, (_, i) => row(i)));
    await service.listRegister(hr, { page: 9 });
    expect(findMany.mock.calls[0][0].skip).toBe(8 * LEAVE_PAGE_SIZE);
  });

  it("filters status in the DATABASE", async () => {
    const { service, where } = makeService([row(1)]);
    await service.listRegister(hr, { status: "APPROVED" });
    expect(where()).toMatchObject({ status: "APPROVED" });
  });

  it("treats from/to as an OVERLAP with the leave dates", async () => {
    // startDate <= to AND endDate >= from. Containment would drop leave that
    // straddles the window — the March/April case above.
    const { service, where } = makeService([row(1)]);
    await service.listRegister(hr, { from: "2025-03-01", to: "2025-03-31" });
    const w = where() as { startDate: { lte: Date }; endDate: { gte: Date } };
    expect(w.startDate.lte).toEqual(new Date("2025-03-31"));
    expect(w.endDate.gte).toEqual(new Date("2025-03-01"));
  });
});

describe("finding one person's leave", () => {
  it("searches by STAFF NAME, because that is how the question arrives", async () => {
    const { service, where, userFindMany } = makeService([row(1)], [{ id: "u7" }, { id: "u9" }]);
    await service.listRegister(hr, { q: "adeyemi" });
    expect(userFindMany.mock.calls[0][0]).toMatchObject({
      where: { name: { contains: "adeyemi", mode: "insensitive" } },
      take: SEARCH_CAP,
    });
    expect(where()).toMatchObject({ userId: { in: ["u7", "u9"] } });
  });

  it("returns NOTHING when the name matches nobody", async () => {
    // The dangerous alternative: an unmatched name leaves the filter off and
    // the register answers with everybody's leave, which reads as "here is what
    // you asked for".
    const { service, findMany } = makeService([row(1)], []);
    const res = await service.listRegister(hr, { q: "nobody-by-that-name" });
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("ignores a blank search rather than matching an empty name", async () => {
    // `user.findMany` IS called either way — the batch decorator resolves staff
    // names for the rows it returns. What must not happen is a NAME lookup.
    const { service, where, userFindMany } = makeService([row(1)]);
    await service.listRegister(hr, { q: "  " });
    const nameLookups = userFindMany.mock.calls.filter(
      (c) => (c[0] as { where?: { name?: unknown } }).where?.name !== undefined,
    );
    expect(nameLookups).toHaveLength(0);
    expect(where()).not.toHaveProperty("userId");
  });
});

describe("the cost of a page", () => {
  it("resolves type and staff names in two queries, whatever the page size", async () => {
    // Fifty rows must not be fifty lookups. The batch decorator is shared with
    // the self-service view for the same reason.
    const { service, userFindMany } = makeService(Array.from({ length: 50 }, (_, i) => row(i)));
    await service.listRegister(hr, {});
    expect(userFindMany).toHaveBeenCalledTimes(1);
  });
});

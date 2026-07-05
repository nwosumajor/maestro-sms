// =============================================================================
// ParentService — the consolidated overview is scoped ENTIRELY through
// ParentChild, aggregates the four dimensions, and audit-logs the read.
// =============================================================================

import { ParentService } from "../../src/parent/parent.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(over: {
  links?: { studentId: string }[];
  session?: Record<string, unknown> | null;
  terms?: { id: string; name: string }[];
  children?: { id: string; name: string }[];
  enrollments?: { studentId: string; classId: string }[];
  attendance?: { studentId: string; status: string; _count: { _all: number } }[];
  results?: { studentId: string; termId: string; total: number | null }[];
  complaints?: { id: string; subject: string; status: string; createdAt: Date; againstId: string }[];
  assignments?: { id: string; assigneeId: string; status: string; task: { title: string; dueAt: Date | null } }[];
  invoices?: { studentId: string; totalMinor: number; payments: { amountMinor: number; kind: string }[] }[];
}) {
  const parentChildFindMany = jest.fn().mockResolvedValue(over.links ?? []);
  const resultFindMany = jest.fn().mockResolvedValue(over.results ?? []);
  const tx = {
    parentChild: { findMany: parentChildFindMany },
    academicSession: { findFirst: jest.fn().mockResolvedValue(over.session ?? null) },
    term: { findMany: jest.fn().mockResolvedValue(over.terms ?? []) },
    user: { findMany: jest.fn().mockResolvedValue(over.children ?? []) },
    enrollment: { findMany: jest.fn().mockResolvedValue(over.enrollments ?? []) },
    attendanceRecord: { groupBy: jest.fn().mockResolvedValue(over.attendance ?? []) },
    subjectResult: { findMany: resultFindMany },
    disciplineComplaint: { findMany: jest.fn().mockResolvedValue(over.complaints ?? []) },
    taskAssignment: { findMany: jest.fn().mockResolvedValue(over.assignments ?? []) },
    class: { findMany: jest.fn().mockResolvedValue([{ id: "c1", name: "JSS1" }]) },
    invoice: { findMany: jest.fn().mockResolvedValue(over.invoices ?? []) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new ParentService(db as never, audit as never), tx, parentChildFindMany, resultFindMany, audit };
}

const parent = (userId = "parent-1"): Principal => ({ schoolId: "A", userId, roles: ["parent"], permissions: ["family.read"] });

describe("ParentService — family overview", () => {
  it("a parent with no linked children gets an empty list and does not query further", async () => {
    const { service, tx } = makeService({ links: [] });
    const out = await service.getFamilyOverview(parent());
    expect(out.children).toEqual([]);
    expect((tx.user.findMany as jest.Mock)).not.toHaveBeenCalled();
  });

  it("scopes EVERY dimension query to the linked children's ids", async () => {
    const { service, tx } = makeService({
      links: [{ studentId: "kid1" }],
      children: [{ id: "kid1", name: "Ada" }],
      enrollments: [{ studentId: "kid1", classId: "c1" }],
    });
    await service.getFamilyOverview(parent());
    for (const call of [
      tx.user.findMany, tx.attendanceRecord.groupBy, tx.disciplineComplaint.findMany,
      tx.taskAssignment.findMany, tx.invoice.findMany,
    ] as jest.Mock[]) {
      const arg = JSON.stringify(call.mock.calls[0][0]);
      expect(arg).toContain("kid1");
    }
  });

  it("aggregates attendance %, published term averages, discipline, tasks and fees", async () => {
    const { service } = makeService({
      links: [{ studentId: "kid1" }],
      session: { id: "sess1", name: "2025/2026" },
      terms: [{ id: "t1", name: "First Term" }, { id: "t2", name: "Second Term" }],
      children: [{ id: "kid1", name: "Ada" }],
      enrollments: [{ studentId: "kid1", classId: "c1" }],
      attendance: [
        { studentId: "kid1", status: "PRESENT", _count: { _all: 8 } },
        { studentId: "kid1", status: "LATE", _count: { _all: 1 } },
        { studentId: "kid1", status: "ABSENT", _count: { _all: 1 } },
      ],
      results: [
        { studentId: "kid1", termId: "t1", total: 70 },
        { studentId: "kid1", termId: "t1", total: 80 },
      ],
      complaints: [{ id: "d1", subject: "Late", status: "OPEN", createdAt: new Date(), againstId: "kid1" }],
      assignments: [{ id: "a1", assigneeId: "kid1", status: "ASSIGNED", task: { title: "Essay", dueAt: null } }],
      invoices: [{ studentId: "kid1", totalMinor: 10000, payments: [{ amountMinor: 4000, kind: "PAYMENT" }] }],
    });
    const { children } = await service.getFamilyOverview(parent());
    const c = children[0];
    expect(c.attendance.pct).toBe(90); // (8 present + 1 late) / 10
    expect(c.grades?.termAverages[0].average).toBe(75); // (70+80)/2
    expect(c.grades?.sessionAverage).toBe(75);
    expect(c.discipline).toHaveLength(1);
    expect(c.tasks[0].title).toBe("Essay");
    expect(c.fees.outstandingMinor).toBe(6000); // 10000 - 4000 paid
    expect(c.fees.unpaidInvoices).toBe(1);
  });

  it("only PUBLISHED results are queried (status filter present)", async () => {
    const { service, resultFindMany } = makeService({
      links: [{ studentId: "kid1" }],
      session: { id: "sess1", name: "2025/2026" },
      children: [{ id: "kid1", name: "Ada" }],
    });
    await service.getFamilyOverview(parent());
    expect(JSON.stringify(resultFindMany.mock.calls[0][0])).toContain("PUBLISHED");
  });

  it("audit-logs the guardian read of minors' records", async () => {
    const { service, audit } = makeService({
      links: [{ studentId: "kid1" }],
      children: [{ id: "kid1", name: "Ada" }],
    });
    await service.getFamilyOverview(parent());
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "family.overview.read" }),
      expect.anything(),
    );
  });
});

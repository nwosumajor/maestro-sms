// =============================================================================
// DashboardService — the home page's tile counts
// =============================================================================
// The point of this service is that the tiles are COUNTS in Postgres rather than
// lists shipped to the browser and counted there. These tests pin both halves of
// that: the queries are counts, and the scoping matches the pages the tiles link
// to.
// =============================================================================

import { DashboardService } from "../../src/dashboard/dashboard.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const svc = (tx: Record<string, unknown>) => {
  const db = {
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
  };
  return new DashboardService(db as never);
};

const principal = (roles: string[], userId = "u1"): Principal => ({
  userId,
  schoolId: "A",
  roles,
  permissions: [],
});

describe("DashboardService.summary", () => {
  it("COUNTS pending approvals rather than counting a page of them", async () => {
    // The bug this replaces: the page fetched /workflows, which caps at its list
    // page by design ("grows without bound over time"), and counted PENDING_REVIEW
    // within that page. Past the cap it under-reported — silently, on a queue
    // nobody is otherwise told to look at.
    const count = jest.fn().mockResolvedValue(137);
    const findMany = jest.fn();
    const out = await svc({
      workflowRequest: { count, findMany },
      class: { count: jest.fn().mockResolvedValue(4), findMany: jest.fn().mockResolvedValue([]) },
      notification: { count: jest.fn().mockResolvedValue(9) },
    }).summary(principal(["principal"]));

    expect(out.pendingApprovals).toBe(137);
    // No rows loaded at all on this path.
    expect(findMany).not.toHaveBeenCalled();
    expect((count.mock.calls[0][0] as { where: { state: string } }).where.state).toBe("PENDING_REVIEW");
  });

  it("a non-reviewer counts only the requests THEY raised", async () => {
    const count = jest.fn().mockResolvedValue(2);
    await svc({
      workflowRequest: { count },
      class: { count: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      classTeacher: { findMany: jest.fn().mockResolvedValue([]) },
      classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
      enrollment: { findMany: jest.fn().mockResolvedValue([]) },
      parentChild: { findMany: jest.fn().mockResolvedValue([]) },
      notification: { count: jest.fn().mockResolvedValue(0) },
    }).summary(principal(["teacher"], "t1"));

    const where = (count.mock.calls[0][0] as { where: { initiatorId?: string } }).where;
    expect(where.initiatorId).toBe("t1");
  });

  it("a reviewer's class tile counts EVERY class; a teacher's counts their own union", async () => {
    const classCount = jest.fn().mockResolvedValue(42);
    const wide = await svc({
      workflowRequest: { count: jest.fn().mockResolvedValue(0) },
      class: { count: classCount, findMany: jest.fn() },
      notification: { count: jest.fn().mockResolvedValue(0) },
    }).summary(principal(["school_admin"]));
    expect(wide.classes).toBe(42);

    // A teacher's classes are the UNION of taught / subject-taught / supervised, so
    // a class reachable two ways must not be counted twice.
    const teacher = await svc({
      workflowRequest: { count: jest.fn().mockResolvedValue(0) },
      class: { count: jest.fn(), findMany: jest.fn().mockResolvedValue([{ id: "c1" }]) },
      classTeacher: { findMany: jest.fn().mockResolvedValue([{ classId: "c1" }, { classId: "c2" }]) },
      classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([{ classId: "c2" }]) },
      notification: { count: jest.fn().mockResolvedValue(0) },
    }).summary(principal(["teacher"]));
    expect(teacher.classes).toBe(2); // c1, c2 — not 4
  });

  it("a parent's class tile falls through to their children's enrolments", async () => {
    const out = await svc({
      workflowRequest: { count: jest.fn().mockResolvedValue(0) },
      class: { count: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      classTeacher: { findMany: jest.fn().mockResolvedValue([]) },
      classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
      enrollment: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([]) // their own enrolments (none — they are not a student)
          .mockResolvedValueOnce([{ classId: "c9" }, { classId: "c9" }]), // two children, same class
      },
      parentChild: { findMany: jest.fn().mockResolvedValue([{ studentId: "s1" }, { studentId: "s2" }]) },
      notification: { count: jest.fn().mockResolvedValue(0) },
    }).summary(principal(["parent"]));
    // Siblings in one class is ONE class on the tile, not two.
    expect(out.classes).toBe(1);
  });

  it("unread notifications are scoped to the caller", async () => {
    const count = jest.fn().mockResolvedValue(6);
    const out = await svc({
      workflowRequest: { count: jest.fn().mockResolvedValue(0) },
      class: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn() },
      notification: { count },
    }).summary(principal(["school_admin"], "me"));
    expect(out.unreadNotifications).toBe(6);
    expect(count.mock.calls[0][0]).toEqual({ where: { recipientId: "me", readAt: null } });
  });
});

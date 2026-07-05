// =============================================================================
// SubjectSelectionService — submit validation + 2-stage maker-checker scoping
// =============================================================================

import { SubjectSelectionService } from "../../src/gradebook/subject-selection.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(over: {
  term?: Record<string, unknown> | null;
  enrollment?: Record<string, unknown> | null;
  klass?: Record<string, unknown> | null;
  offered?: { subjectId: string }[];
  existing?: Record<string, unknown> | null;
  updateManyCount?: number;
}) {
  const create = jest.fn(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "sel1", createdAt: new Date(), updatedAt: new Date(), reviewNote: null, supervisorActedById: null, reviewedById: null, ...data }),
  );
  const update = jest.fn(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "sel1", createdAt: new Date(), updatedAt: new Date(), termId: "t1", studentId: "stu1", ...data }),
  );
  const updateMany = jest.fn().mockResolvedValue({ count: over.updateManyCount ?? 1 });
  const tx = {
    term: { findFirst: jest.fn().mockResolvedValue(over.term ?? null) },
    academicSession: { findFirst: jest.fn().mockResolvedValue(null) },
    enrollment: { findFirst: jest.fn().mockResolvedValue(over.enrollment ?? null) },
    class: { findFirst: jest.fn().mockResolvedValue(over.klass ?? null) },
    classSubjectTeacher: {
      // Respect the `subjectId: { in: [...] }` filter like Prisma would — the
      // service compares matched count to picked count.
      findMany: jest.fn().mockImplementation((args: { where?: { subjectId?: { in?: string[] } } }) => {
        const all = over.offered ?? [];
        const wanted = args?.where?.subjectId?.in;
        return Promise.resolve(wanted ? all.filter((o) => wanted.includes(o.subjectId)) : all);
      }),
    },
    subject: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    subjectSelection: {
      findFirst: jest.fn().mockResolvedValue(over.existing ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      create,
      update,
      updateMany,
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new SubjectSelectionService(db as never, audit as never), tx, create, update, updateMany, audit };
}

const p = (roles: string[], userId: string, permissions: string[] = []): Principal => ({
  schoolId: "A", userId, roles, permissions,
});

const submitBase = {
  term: { id: "t1", sessionId: "sess1" },
  enrollment: { classId: "c1" },
  offered: [{ subjectId: "s1" }, { subjectId: "s2" }],
};

describe("SubjectSelectionService — student submit", () => {
  it("a valid pick creates a PENDING_SUPERVISOR row naming the class supervisor", async () => {
    const { service, create } = makeService({
      ...submitBase,
      klass: { id: "c1", supervisorId: "sup1" },
    });
    const dto = await service.submit(p(["student"], "stu1"), { termId: "t1", subjectIds: ["s1", "s2"] });
    expect(dto.status).toBe("PENDING_SUPERVISOR");
    expect(dto.supervisorId).toBe("sup1");
    expect(create).toHaveBeenCalled();
  });

  it("a class with NO supervisor skips straight to the admin stage", async () => {
    const { service } = makeService({
      ...submitBase,
      klass: { id: "c1", supervisorId: null },
    });
    const dto = await service.submit(p(["student"], "stu1"), { termId: "t1", subjectIds: ["s1"] });
    expect(dto.status).toBe("PENDING_ADMIN");
  });

  it("a subject NOT fixed on the class is rejected", async () => {
    const { service } = makeService({
      ...submitBase,
      offered: [{ subjectId: "s1" }], // s2 not offered
      klass: { id: "c1", supervisorId: "sup1" },
    });
    await expect(
      service.submit(p(["student"], "stu1"), { termId: "t1", subjectIds: ["s1", "s2"] }),
    ).rejects.toThrow(/offered on your class/i);
  });

  it("resubmission is only possible after rejection — a pending/approved row locks", async () => {
    const { service } = makeService({
      ...submitBase,
      klass: { id: "c1", supervisorId: "sup1" },
      existing: { id: "sel1", status: "PENDING_ADMIN" },
    });
    await expect(
      service.submit(p(["student"], "stu1"), { termId: "t1", subjectIds: ["s1"] }),
    ).rejects.toThrow(/already awaiting approval/i);
  });

  it("a REJECTED row is resubmitted in place (update, not a second row)", async () => {
    const { service, update, create } = makeService({
      ...submitBase,
      klass: { id: "c1", supervisorId: "sup1" },
      existing: { id: "sel1", status: "REJECTED" },
    });
    await service.submit(p(["student"], "stu1"), { termId: "t1", subjectIds: ["s1"] });
    expect(update).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("SubjectSelectionService — 2-stage review", () => {
  const pendingSupervisor = {
    id: "sel1", sessionId: "sess1", termId: "t1", classId: "c1", studentId: "stu1",
    subjectIds: ["s1"], status: "PENDING_SUPERVISOR", supervisorId: "sup1",
    supervisorActedById: null, reviewedById: null, reviewNote: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const pendingAdmin = { ...pendingSupervisor, status: "PENDING_ADMIN", supervisorActedById: "sup1" };

  it("stage 1: ONLY the named supervisor may act — another teacher gets 404", async () => {
    const { service } = makeService({ existing: pendingSupervisor });
    await expect(
      service.review(p(["teacher"], "someone-else"), "sel1", { action: "APPROVE" }),
    ).rejects.toThrow(/not found/i);
  });

  it("stage 1: the supervisor's APPROVE advances to PENDING_ADMIN", async () => {
    const { service, updateMany } = makeService({ existing: pendingSupervisor });
    await service.review(p(["teacher"], "sup1"), "sel1", { action: "APPROVE" });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sel1", status: "PENDING_SUPERVISOR" },
        data: expect.objectContaining({ status: "PENDING_ADMIN", supervisorActedById: "sup1" }),
      }),
    );
  });

  it("stage 2: requires subject.selection.approve — a plain teacher gets 404", async () => {
    const { service } = makeService({ existing: pendingAdmin });
    await expect(
      service.review(p(["teacher"], "someone"), "sel1", { action: "APPROVE" }),
    ).rejects.toThrow(/not found/i);
  });

  it("stage 2: the SAME person who passed stage 1 cannot finalize (SoD)", async () => {
    const { service } = makeService({ existing: pendingAdmin });
    await expect(
      service.review(p(["head_teacher"], "sup1", ["subject.selection.approve"]), "sel1", { action: "APPROVE" }),
    ).rejects.toThrow(/different person/i);
  });

  it("stage 2: an approver finalizes to APPROVED", async () => {
    const { service, updateMany } = makeService({ existing: pendingAdmin });
    await service.review(p(["school_admin"], "admin1", ["subject.selection.approve"]), "sel1", { action: "APPROVE" });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sel1", status: "PENDING_ADMIN" },
        data: expect.objectContaining({ status: "APPROVED", reviewedById: "admin1" }),
      }),
    );
  });

  it("the student can never review their own selection", async () => {
    const { service } = makeService({ existing: pendingSupervisor });
    await expect(
      service.review(p(["student"], "stu1"), "sel1", { action: "APPROVE" }),
    ).rejects.toThrow(/own selection/i);
  });

  it("a concurrent review that already moved the row is refused (optimistic guard)", async () => {
    const { service } = makeService({ existing: pendingAdmin, updateManyCount: 0 });
    await expect(
      service.review(p(["school_admin"], "admin1", ["subject.selection.approve"]), "sel1", { action: "APPROVE" }),
    ).rejects.toThrow(/just updated/i);
  });
});

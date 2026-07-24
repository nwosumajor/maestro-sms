// =============================================================================
// DisciplineService — filing, staff-only review, self-scope unit tests
// =============================================================================

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { DisciplineService } from "../../src/discipline/discipline.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = { schoolId: "A", userId: "teach", roles: ["teacher"], permissions: ["discipline.file", "discipline.manage"] };
const filer: Principal = { schoolId: "A", userId: "stu1", roles: ["student"], permissions: ["discipline.file"] };

function makeTx(over: Record<string, unknown> = {}) {
  const calls = { create: 0, resolveUpdate: 0 };
  const tx = {
    disciplineComplaint: {
      create: jest.fn(() => { calls.create++; return Promise.resolve({ id: "c1" }); }),
      findFirst: jest.fn().mockResolvedValue(over.complaint ?? { id: "c1", complainantId: "stu1", againstId: "stu2", againstType: "STUDENT", status: "OPEN", resolution: null }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: "c1", subject: "S", details: null, complainantId: "stu1", againstId: "stu2", againstType: "STUDENT", status: "OPEN", resolution: null, createdAt: new Date() }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(() => { calls.resolveUpdate++; return Promise.resolve({}); }),
    },
    disciplineAssignee: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    disciplineEvidence: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    disciplineEntry: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "stu2", name: "Sub" }), findMany: jest.fn().mockResolvedValue([{ id: "stu1", name: "Filer" }, { id: "stu2", name: "Sub" }, { id: "stu3", name: "Mate" }]) },
    // Relationship scope: stu1 is enrolled in cl1 with classmates stu2/stu3.
    enrollment: {
      findMany: jest.fn().mockResolvedValue(over.enrollments ?? [{ classId: "cl1", studentId: "stu1" }, { classId: "cl1", studentId: "stu2" }, { classId: "cl1", studentId: "stu3" }]),
      // In-scope target by default; override to null to prove the out-of-scope guard.
      findFirst: jest.fn().mockResolvedValue("targetEnrollment" in over ? over.targetEnrollment : { id: "en1" }),
    },
    parentChild: { findMany: jest.fn().mockResolvedValue(over.children ?? []) },
    classTeacher: { findMany: jest.fn().mockResolvedValue(over.classTeachers ?? []) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue(over.subjectTeachers ?? []) },
    class: { findMany: jest.fn().mockResolvedValue(over.supervised ?? []), findFirst: jest.fn().mockResolvedValue(null) },
  } as unknown as TenantTx;
  return { tx, calls };
}

function svc(tx: TenantTx) {
  const run = <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx);
  const db = { runAsTenant: run, runAsTenantReadOnly: run };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const storage = { presignUpload: jest.fn(), presignDownload: jest.fn(), delete: jest.fn() };
  return new DisciplineService(db as never, audit as never, storage as never);
}

describe("DisciplineService", () => {
  it("anyone can file a complaint", async () => {
    const { tx, calls } = makeTx();
    const dto = await svc(tx).file(filer, { subject: "Bullying", againstId: "stu2", againstType: "STUDENT" });
    expect(calls.create).toBe(1);
    expect(dto.id).toBe("c1");
  });

  it("a non-manager can only file against someone in their relationship scope (out-of-scope → 404)", async () => {
    // Target exists in the school but is NOT a classmate/teacher of the filer.
    const { tx, calls } = makeTx({ targetEnrollment: null });
    await expect(
      svc(tx).file(filer, { subject: "x", againstId: "stranger", againstType: "STUDENT" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(calls.create).toBe(0); // never written
  });

  it("listFileTargets STUDENT returns classmates and EXCLUDES the caller", async () => {
    const { tx } = makeTx();
    await svc(tx).listFileTargets(filer, "STUDENT");
    // The id filter sent to the DB must omit the caller (stu1) — no self-reports,
    // and only classmates in the filer's own classes.
    const call = (tx.user.findMany as jest.Mock).mock.calls[0][0];
    expect(call.where.id.in).toEqual(expect.arrayContaining(["stu2", "stu3"]));
    expect(call.where.id.in).not.toContain("stu1");
  });

  it("a manager files against anyone (scope check bypassed)", async () => {
    // Even with NO relationship rows, a manager's file succeeds — scope is for
    // non-managers only.
    const { tx, calls } = makeTx({ enrollments: [], targetEnrollment: null });
    await svc(tx).file(staff, { subject: "x", againstId: "anyone", againstType: "STUDENT" });
    expect(calls.create).toBe(1);
  });

  it("a non-staff filer CANNOT assign a resolver", async () => {
    const { tx } = makeTx();
    await expect(svc(tx).assign(filer, "c1", "stu3")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a non-staff filer CANNOT resolve", async () => {
    const { tx } = makeTx();
    await expect(svc(tx).resolve(filer, "c1", { status: "RESOLVED", resolution: "warning" })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("staff resolve records a human decision (status + resolution)", async () => {
    const { tx, calls } = makeTx();
    const dto = await svc(tx).resolve(staff, "c1", { status: "RESOLVED", resolution: "Verbal warning" });
    expect(calls.resolveUpdate).toBe(1);
    expect(dto.id).toBe("c1");
  });

  it("a filer cannot read someone else's complaint (404, no leak)", async () => {
    const { tx } = makeTx({ complaint: { id: "c1", complainantId: "someone-else", againstId: "stu2", status: "OPEN" } });
    await expect(svc(tx).get(filer, "c1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("list BATCHES child + name lookups (no per-complaint fan-out)", async () => {
    // Two complaints, each with an assignee/evidence/entry: a batched list issues
    // ONE findMany per child table + ONE user lookup, and NEVER the per-row
    // findFirstOrThrow that the old N+1 used.
    const complaintFindFirstOrThrow = jest.fn(); // must NOT be called on the list path
    const assigneeFindMany = jest.fn().mockResolvedValue([{ id: "a1", complaintId: "c1", assigneeId: "teach", createdAt: new Date() }]);
    const evidenceFindMany = jest.fn().mockResolvedValue([{ id: "e1", complaintId: "c2", uploadedById: "teach", fileName: "photo.jpg", createdAt: new Date() }]);
    const entryFindMany = jest.fn().mockResolvedValue([{ id: "n1", complaintId: "c1", authorId: "teach", body: "note", createdAt: new Date() }]);
    const userFindMany = jest.fn().mockResolvedValue([
      { id: "teach", name: "Teacher" }, { id: "stu1", name: "Filer" }, { id: "stu2", name: "Sub" },
    ]);
    const tx = {
      disciplineComplaint: {
        findMany: jest.fn().mockResolvedValue([
          { id: "c1", subject: "One", details: null, complainantId: "stu1", againstId: "stu2", againstType: "STUDENT", status: "OPEN", resolution: null, createdAt: new Date() },
          { id: "c2", subject: "Two", details: null, complainantId: "stu1", againstId: "teach", againstType: "TEACHER", status: "OPEN", resolution: null, createdAt: new Date() },
        ]),
        findFirstOrThrow: complaintFindFirstOrThrow,
      },
      disciplineAssignee: { findMany: assigneeFindMany },
      disciplineEvidence: { findMany: evidenceFindMany },
      disciplineEntry: { findMany: entryFindMany },
      user: { findMany: userFindMany },
    } as unknown as TenantTx;

    const dtos = (await svc(tx).list(staff)).items;
    expect(dtos).toHaveLength(2);
    // Children land on the right complaint, names resolved from the ONE user map.
    const c1 = dtos.find((d) => d.id === "c1");
    const c2 = dtos.find((d) => d.id === "c2");
    expect(c1?.assignees[0]?.assigneeName).toBe("Teacher");
    expect(c1?.entries[0]?.body).toBe("note");
    expect(c2?.evidence[0]?.fileName).toBe("photo.jpg");
    expect(c2?.againstName).toBe("Teacher");
    // ONE query per child table + ONE user lookup; no per-complaint re-fetch.
    expect(assigneeFindMany).toHaveBeenCalledTimes(1);
    expect(evidenceFindMany).toHaveBeenCalledTimes(1);
    expect(entryFindMany).toHaveBeenCalledTimes(1);
    expect(userFindMany).toHaveBeenCalledTimes(1);
    expect(complaintFindFirstOrThrow).not.toHaveBeenCalled();
  });
});

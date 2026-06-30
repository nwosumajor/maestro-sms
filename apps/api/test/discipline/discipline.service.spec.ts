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
    user: { findFirst: jest.fn().mockResolvedValue({ id: "stu2", name: "Sub" }), findMany: jest.fn().mockResolvedValue([{ id: "stu1", name: "Filer" }, { id: "stu2", name: "Sub" }]) },
  } as unknown as TenantTx;
  return { tx, calls };
}

function svc(tx: TenantTx) {
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
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
});

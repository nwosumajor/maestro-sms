// =============================================================================
// ScholarshipService — applicant scoping + consent/submit gates (pure unit)
// =============================================================================

import { ScholarshipService } from "../../src/scholarship/scholarship.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const OPEN_PROGRAM = {
  id: "prog1",
  title: "STEM Scholarship",
  description: null,
  budgetMinor: 1_000_000,
  awardMinor: 50_000,
  awardKind: "FEES_CREDIT",
  selectionBasis: "BOTH",
  eligibility: null,
  status: "OPEN",
  opensAt: new Date(Date.now() - 86_400_000),
  closesAt: new Date(Date.now() + 86_400_000),
  createdAt: new Date(),
};

function makeService(over: {
  program?: Record<string, unknown> | null;
  children?: { studentId: string }[];
  taught?: { classId: string }[];
  enrolled?: { studentId: string }[];
  existingApplication?: Record<string, unknown> | null;
  application?: Record<string, unknown> | null;
  guardianLink?: Record<string, unknown> | null;
}) {
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const tx = {
    scholarshipProgram: {
      findFirst: jest.fn().mockResolvedValue(over.program ?? OPEN_PROGRAM),
      findMany: jest.fn().mockResolvedValue(over.program === null ? [] : [OPEN_PROGRAM]),
    },
    scholarshipApplication: {
      findFirst: jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        // apply()'s duplicate check vs. ownDraft/consent lookups.
        if ("programId" in where && "studentId" in where) return Promise.resolve(over.existingApplication ?? null);
        return Promise.resolve(over.application ?? null);
      }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: "app1", createdAt: new Date(), updatedAt: new Date(), consentById: null, consentAt: null, awardMinor: null, reviewNote: null, signals: null, ...data };
        created.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return Promise.resolve({ id: "app1", programId: "prog1", schoolId: "A", studentId: "stu1", applicantId: "par1", applicantRole: "parent", answers: null, signals: null, status: "DRAFT", consentById: null, consentAt: null, awardMinor: null, reviewNote: null, createdAt: new Date(), updatedAt: new Date(), ...(over.application ?? {}), ...data });
      }),
    },
    parentChild: {
      findMany: jest.fn().mockResolvedValue(over.children ?? []),
      findFirst: jest.fn().mockResolvedValue(over.guardianLink ?? null),
    },
    classTeacher: { findMany: jest.fn().mockResolvedValue(over.taught ?? []) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue(over.enrolled ?? []) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "stu1", name: "Ada" }, { id: "par1", name: "Mum" }]) },
    subjectResult: { findMany: jest.fn().mockResolvedValue([]) },
    attendanceRecord: { groupBy: jest.fn().mockResolvedValue([]) },
    invoice: { findMany: jest.fn().mockResolvedValue([]) },
    disciplineComplaint: { count: jest.fn().mockResolvedValue(0) },
    taskAssignment: { count: jest.fn().mockResolvedValue(0) },
    userRole: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new ScholarshipService(db as never, audit as never, notifications as never);
  return { service, tx, created, updates, audit };
}

const parent = (userId = "par1"): Principal => ({ schoolId: "A", userId, roles: ["parent"], permissions: [] });
const teacher = (userId = "tch1"): Principal => ({ schoolId: "A", userId, roles: ["teacher"], permissions: [] });

describe("ScholarshipService — apply scoping + consent/submit", () => {
  it("a parent can apply for their own child", async () => {
    const { service, created } = makeService({ children: [{ studentId: "stu1" }] });
    const dto = await service.apply(parent(), { programId: "prog1", studentId: "stu1" });
    expect(dto.status).toBe("DRAFT");
    expect(created[0].applicantRole).toBe("parent");
  });

  it("applying for a student you have no relationship with is 404 (not 403)", async () => {
    const { service } = makeService({ children: [{ studentId: "other-kid" }] });
    await expect(service.apply(parent(), { programId: "prog1", studentId: "stu1" })).rejects.toThrow(/not found/i);
  });

  it("a teacher can apply for a student in a class they teach", async () => {
    const { service, created } = makeService({ taught: [{ classId: "c1" }], enrolled: [{ studentId: "stu1" }] });
    const dto = await service.apply(teacher(), { programId: "prog1", studentId: "stu1" });
    expect(dto.status).toBe("DRAFT");
    expect(created[0].applicantRole).toBe("teacher");
  });

  it("a duplicate application for the same student+program is rejected", async () => {
    const { service } = makeService({ children: [{ studentId: "stu1" }], existingApplication: { id: "old" } });
    await expect(service.apply(parent(), { programId: "prog1", studentId: "stu1" })).rejects.toThrow(/already exists/i);
  });

  it("applying to a program that isn't OPEN is rejected", async () => {
    const closed = { ...OPEN_PROGRAM, status: "CLOSED" };
    const { service } = makeService({ program: closed, children: [{ studentId: "stu1" }] });
    await expect(service.apply(parent(), { programId: "prog1", studentId: "stu1" })).rejects.toThrow(/not open/i);
  });

  it("submit is blocked until a guardian has consented", async () => {
    const { service } = makeService({
      children: [{ studentId: "stu1" }],
      application: { id: "app1", applicantId: "par1", studentId: "stu1", status: "DRAFT", consentAt: null },
    });
    await expect(service.submit(parent(), "app1")).rejects.toThrow(/consent/i);
  });

  it("only a guardian of the student may consent", async () => {
    const { service } = makeService({
      application: { id: "app1", studentId: "stu1", status: "DRAFT" },
      guardianLink: null, // caller is NOT a guardian of stu1
    });
    await expect(service.consent(teacher(), "app1")).rejects.toThrow(/guardian/i);
  });

  it("submit snapshots signals and flips DRAFT -> SUBMITTED once consented", async () => {
    const { service, updates } = makeService({
      children: [{ studentId: "stu1" }],
      application: { id: "app1", applicantId: "par1", studentId: "stu1", status: "DRAFT", consentAt: new Date() },
    });
    const dto = await service.submit(parent(), "app1");
    expect(dto.status).toBe("SUBMITTED");
    const submitUpdate = updates.find((u) => u.status === "SUBMITTED");
    expect(submitUpdate).toBeDefined();
    expect(submitUpdate!.signals).toBeDefined();
  });
});

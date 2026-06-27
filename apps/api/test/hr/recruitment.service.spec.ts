// =============================================================================
// RecruitmentService — pipeline + convert-to-staff unit tests
// =============================================================================

import { RecruitmentService } from "../../src/hr/recruitment.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function make(over: { applicant?: Record<string, unknown> | null; requisition?: Record<string, unknown> | null; userExists?: boolean } = {}) {
  const userCreate = jest.fn().mockResolvedValue({ id: "newuser" });
  const employeeCreate = jest.fn().mockResolvedValue({});
  const applicantUpdate = jest.fn().mockResolvedValue({});
  const tx = {
    jobRequisition: {
      create: jest.fn().mockResolvedValue({ id: "r1", title: "Teacher", department: null, description: null, status: "OPEN", openings: 1, createdAt: new Date() }),
      findFirst: jest.fn().mockResolvedValue(over.requisition ?? { id: "r1", title: "Teacher" }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    applicant: {
      create: jest.fn((a: { data: Record<string, unknown> }) => Promise.resolve({ id: "ap1", requisitionId: "r1", name: "Jane", email: "jane@x", phone: null, stage: "APPLIED", notes: null, convertedUserId: null, createdAt: new Date(), ...a.data })),
      findFirst: jest.fn().mockResolvedValue(over.applicant ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      update: applicantUpdate,
      count: jest.fn().mockResolvedValue(0),
    },
    user: { findFirst: jest.fn().mockResolvedValue(over.userExists ? { id: "exists" } : null), create: userCreate },
    employee: { create: employeeCreate },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new RecruitmentService(db as never, audit as never), userCreate, employeeCreate, applicantUpdate };
}

const p = (userId = "hr1"): Principal => ({ schoolId: "A", userId, roles: [], permissions: [] });

describe("RecruitmentService", () => {
  it("moveStage validates the stage", async () => {
    const { service } = make({ applicant: { id: "ap1", stage: "APPLIED" } });
    await expect(service.moveStage(p(), "ap1", "BOGUS")).rejects.toThrow(/invalid stage/i);
  });

  it("convert provisions a User + Employee and marks the applicant HIRED", async () => {
    const { service, userCreate, employeeCreate, applicantUpdate } = make({
      applicant: { id: "ap1", requisitionId: "r1", name: "Jane", email: "jane@x", convertedUserId: null },
      requisition: { title: "Teacher" },
    });
    const res = await service.convert(p(), "ap1", {});
    expect(userCreate).toHaveBeenCalled();
    expect(employeeCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: "newuser", jobTitle: "Teacher" }) }));
    expect(applicantUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { stage: "HIRED", convertedUserId: "newuser" } }));
    expect(res.tempPassword).toBeTruthy();
  });

  it("convert refuses if a user with that email already exists", async () => {
    const { service } = make({ applicant: { id: "ap1", requisitionId: "r1", email: "jane@x", convertedUserId: null }, userExists: true });
    await expect(service.convert(p(), "ap1", {})).rejects.toThrow(/already exists/i);
  });

  it("convert refuses an already-converted applicant", async () => {
    const { service } = make({ applicant: { id: "ap1", requisitionId: "r1", email: "jane@x", convertedUserId: "u9" } });
    await expect(service.convert(p(), "ap1", {})).rejects.toThrow(/already converted/i);
  });
});

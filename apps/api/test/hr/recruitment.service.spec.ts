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
  const storage = { upload: jest.fn(), download: jest.fn(), delete: jest.fn(), presignUpload: jest.fn(), presignDownload: jest.fn() };
  // Hiring now carries the candidate's paperwork over and opens their
  // onboarding list, in the hire's own transaction. Both are spied so the tests
  // below can assert they happened rather than trusting that they did.
  const promoteApplicantInTx = jest.fn().mockResolvedValue({ promoted: 0, cvCarried: false });
  const createChecklistInTx = jest.fn().mockResolvedValue({ checklist: { id: "cl-1" }, items: [] });
  return {
    service: new RecruitmentService(
      db as never,
      audit as never,
      storage as never,
      { promoteApplicantInTx } as never,
      { createChecklistInTx } as never,
    ),
    userCreate,
    employeeCreate,
    applicantUpdate,
    promoteApplicantInTx,
    createChecklistInTx,
  };
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

// -----------------------------------------------------------------------------
// Hiring somebody carries their paperwork with them
// -----------------------------------------------------------------------------
// Both of these were built and then never connected. `Applicant.cvKey` held the
// one document the school had actually collected, and convert() created the user
// and the employee and never looked at it — so the CV was orphaned the moment a
// candidate was hired. And `staff_checklist`, which exists precisely to open an
// onboarding list with default tasks, was never created by the one event that
// should create it.
//
// Both now run INSIDE the hire's transaction: hiring is one decision, so the
// account, the employment record, the documents and the list either all happen
// or none do.
// -----------------------------------------------------------------------------

describe("what a hire carries over", () => {
  // make() defaults the applicant to null, which is "not found" — every case
  // here needs a real one.
  const candidate = { id: "a1", email: "x@y.z", name: "A", stage: "OFFER", cvKey: null, cvName: null };

  it("takes the candidate's CV with them", async () => {
    const { service, promoteApplicantInTx } = make({ applicant: { id: "a1", email: "x@y.z", name: "A", stage: "OFFER", cvKey: "careers/school/abc.pdf", cvName: "ada-cv.pdf" } });
    await service.convert(p(), "a1", {});
    expect(promoteApplicantInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ applicantId: "a1", cvKey: "careers/school/abc.pdf", cvName: "ada-cv.pdf" }),
    );
  });

  it("opens their onboarding list", async () => {
    const { service, createChecklistInTx } = make({ applicant: candidate });
    const out = await service.convert(p(), "a1", {});
    expect(createChecklistInTx).toHaveBeenCalledWith(expect.anything(), "A", "hr1", out.userId, "ONBOARDING");
  });

  it("does both in the SAME transaction as the account it creates", async () => {
    // The property that makes it one decision. Both helpers must be handed the
    // transaction the hire is running in — a nested one would commit
    // independently and could leave a checklist for staff who do not exist.
    const { service, promoteApplicantInTx, createChecklistInTx } = make({ applicant: candidate });
    await service.convert(p(), "a1", {});
    const txGivenToPromote = promoteApplicantInTx.mock.calls[0][0];
    const txGivenToChecklist = createChecklistInTx.mock.calls[0][0];
    expect(txGivenToPromote).toBe(txGivenToChecklist);
    expect(txGivenToPromote).toBeTruthy();
  });

  it("still hires somebody who sent no CV", async () => {
    const { service, promoteApplicantInTx, userCreate } = make({ applicant: { id: "a1", email: "x@y.z", name: "A", stage: "OFFER", cvKey: null, cvName: null } });
    await service.convert(p(), "a1", {});
    expect(userCreate).toHaveBeenCalled();
    expect(promoteApplicantInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cvKey: null }));
  });
});

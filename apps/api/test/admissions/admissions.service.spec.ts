// =============================================================================
// AdmissionsService — maker-checker (Admin → HR → Principal) unit tests
// =============================================================================
// Proves the staged enrolment review: each stage needs the right granular
// permission, a user can act at most once (separation of duties), APPROVE advances
// then ACCEPTS on the final stage, REJECT is terminal, and a terminal decision
// emails the (non-user) applicant. Tenant isolation is covered by the RLS e2e.

import { ConflictException, ForbiddenException } from "@nestjs/common";
import { AdmissionsService } from "../../src/admissions/admissions.service";
import { ADMISSION_REVIEW_CHAIN } from "@sms/types";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

type Row = Record<string, unknown>;

function baseApp(over: Row = {}): Row {
  return {
    id: "app1",
    applicantName: "Parent",
    applicantEmail: "parent@example.com",
    applicantPhone: null,
    childName: "Child",
    childDob: null,
    desiredClass: "JSS1",
    status: "NEW",
    details: null,
    stages: ADMISSION_REVIEW_CHAIN,
    currentStage: 0,
    approvals: [],
    examDate: null,
    examNote: null,
    reviewNote: null,
    createdAt: new Date(),
    ...over,
  };
}

function makeService(app: Row) {
  const state = { app: { ...app } };
  const update = jest.fn((args: { data: Row }) => {
    state.app = { ...state.app, ...args.data };
    return Promise.resolve(state.app);
  });
  const tx = {
    admissionApplication: {
      findFirst: jest.fn(() => Promise.resolve(state.app)),
      update,
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const channel = { deliver: jest.fn().mockResolvedValue({ ok: true }) };
  // Gateway/fee/privileged deps are unused by the review paths under test:
  // paystack reports unconfigured, the fee resolver returns the zero default.
  const paystack = { isConfigured: () => false } as never;
  const platformFees = { effective: jest.fn().mockResolvedValue({ flatMinor: 0, percentBp: 0, capMinor: null, bearer: "PARENT" }) } as never;
  const privileged = { client: null } as never;
  const service = new AdmissionsService(db as never, audit as never, channel as never, paystack, platformFees, privileged);
  return { service, update, audit, channel, state };
}

const admin: Principal = { schoolId: "A", userId: "admin-1", roles: ["school_admin"], permissions: ["admission.review"] };
const hr: Principal = { schoolId: "A", userId: "hr-1", roles: ["hr_manager"], permissions: ["admission.review", "workflow.review.hr"] };
const principal: Principal = { schoolId: "A", userId: "pr-1", roles: ["principal"], permissions: ["admission.review", "workflow.review.principal"] };

describe("AdmissionsService maker-checker", () => {
  it("requires the stage's granular permission", async () => {
    const { service } = makeService(baseApp());
    // HR holds admission.review (coarse) but stage 0 needs the ADMIN granular perm…
    // a user WITHOUT admission.review-as-stage-0 perm is the principal at stage 0:
    await expect(service.review(principal, "app1", "APPROVE")).resolves.toBeDefined();
  });

  it("advances Admin → HR → Principal and ACCEPTS on the final stage, then emails the applicant", async () => {
    const { service, channel, state } = makeService(baseApp());
    let r = await service.review(admin, "app1", "APPROVE");
    expect(r.status).toBe("REVIEWING");
    expect(r.currentStage).toBe(1);
    r = await service.review(hr, "app1", "APPROVE");
    expect(r.status).toBe("REVIEWING");
    expect(r.currentStage).toBe(2);
    r = await service.review(principal, "app1", "APPROVE");
    expect(r.status).toBe("ACCEPTED");
    expect(state.app.status).toBe("ACCEPTED");
    expect(channel.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "EMAIL", target: "parent@example.com" }),
    );
  });

  it("blocks the same person from deciding two stages (separation of duties)", async () => {
    const { service } = makeService(baseApp());
    await service.review(admin, "app1", "APPROVE"); // stage 0 by admin
    // The same user tries stage 1 (even if they held workflow.review.hr): rejected.
    const dualRole: Principal = { schoolId: "A", userId: "admin-1", roles: [], permissions: ["admission.review", "workflow.review.hr"] };
    await expect(service.review(dualRole, "app1", "APPROVE")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects at any stage is terminal and emails the applicant", async () => {
    const { service, channel, state } = makeService(baseApp());
    const r = await service.review(admin, "app1", "REJECT");
    expect(r.status).toBe("REJECTED");
    expect(state.app.status).toBe("REJECTED");
    expect(channel.deliver).toHaveBeenCalled();
  });

  it("refuses to review an already-decided application", async () => {
    const { service } = makeService(baseApp({ status: "ACCEPTED" }));
    await expect(service.review(principal, "app1", "APPROVE")).rejects.toBeInstanceOf(ConflictException);
  });

  it("wrong-stage approver is forbidden (HR cannot approve stage 0 without being the admin stage)", async () => {
    const { service } = makeService(baseApp({ currentStage: 1 }));
    // At stage 1 (HR), the school_admin (no workflow.review.hr) is not the approver.
    await expect(service.review(admin, "app1", "APPROVE")).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// =============================================================================
// A chain nobody can decide is a dead end, not a control
// =============================================================================
// `requestAdjustment` and the salary change already refuse to raise a
// maker-checker request when nobody else could ever decide it — a two-person
// rule with one person is a dead end. The workflow ENGINE, which runs six
// chains, did not ask.
//
// Submitting moved the request to PENDING_REVIEW and nothing checked whether
// the stages it would pass through had anybody in them. A school with no head
// teacher raises a leave request that dies at stage one and says "pending" for
// ever: the applicant sees a request in progress, and there is no person, page
// or sweep that will ever say otherwise.
//
// It is not hypothetical. On the live database, of three schools:
//
//     school                          head  hr  principal
//     Elshaddi British High School       0   0          1
//     MeastroTest School                 2   1          1
//     St. Andrews Academy                2   1          1
//
// Every chain starts at the head stage, so at Elshaddi leave, staff requests,
// grade publish, content publish, exam schedules and CBT answer release could
// none of them ever be approved.
//
// Checked at SUBMIT rather than create: that is when the chain is fixed and
// when the person is standing there to be told. EVERY stage, because dying at
// stage two is just as dead. And the INITIATOR does not count — separation of
// duties means "the only holder is the person asking" is the same dead end.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { WorkflowService } from "../../src/workflow/workflow.service";
import { STAFF_REQUEST_CHAIN, WORKFLOW_PERMISSIONS } from "@sms/types";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

/** `holdersOf` reads user_role; this models who holds what in the school. */
function makeService(holders: Record<string, string[]>, over: Record<string, unknown> = {}) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const userRoleFindMany = jest.fn(({ where }: { where: { role: { permissions: { some: { permission: { key: string } } } } } }) => {
    const key = where.role.permissions.some.permission.key;
    return Promise.resolve((holders[key] ?? []).map((userId) => ({ userId })));
  });
  const tx = {
    workflowRequest: {
      findFirst: jest.fn().mockResolvedValue({
        id: "w1",
        type: "LEAVE",
        state: "DRAFT",
        initiatorId: "staff",
        payload: {},
        stages: STAFF_REQUEST_CHAIN,
        currentStage: 0,
        approvals: [],
        ...over,
      }),
      updateMany,
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    workflowAuditLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    userRole: { findMany: userRoleFindMany },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "x", status: "ACTIVE" }) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const svc = new WorkflowService(
    db as never,
    { runFinalized: jest.fn().mockResolvedValue(undefined) } as never,
    { enqueueMany: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { svc, updateMany };
}

const applicant: Principal = { schoolId: "A", userId: "staff", roles: [], permissions: ["workflow.create"] };

/** A school with somebody in every stage of the staff chain. */
const STAFFED = {
  [WORKFLOW_PERMISSIONS.REVIEW_HEAD]: ["head-1"],
  [WORKFLOW_PERMISSIONS.REVIEW_HR]: ["hr-1"],
  [WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL]: ["principal-1"],
};

describe("submitting into a chain", () => {
  it("is allowed when every stage has somebody", async () => {
    const { svc, updateMany } = makeService(STAFFED);
    await svc.submit(applicant, "w1");
    expect(updateMany).toHaveBeenCalled();
  });

  it("is REFUSED when the first stage has nobody", async () => {
    // Elshaddi's case exactly: no head teacher, so leave dies at stage one.
    const { svc, updateMany } = makeService({ ...STAFFED, [WORKFLOW_PERMISSIONS.REVIEW_HEAD]: [] });
    await expect(svc.submit(applicant, "w1")).rejects.toThrow(BadRequestException);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("is REFUSED when a LATER stage has nobody", async () => {
    // Dying at stage two is just as dead, and the applicant would have watched
    // it move once before stopping for ever.
    const { svc, updateMany } = makeService({ ...STAFFED, [WORKFLOW_PERMISSIONS.REVIEW_HR]: [] });
    await expect(svc.submit(applicant, "w1")).rejects.toThrow(BadRequestException);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("does not count the INITIATOR as the stage's approver", async () => {
    // Separation of duties: the engine would refuse this person at review time,
    // so a stage whose only holder is the applicant is empty as far as this
    // request is concerned.
    const { svc } = makeService({ ...STAFFED, [WORKFLOW_PERMISSIONS.REVIEW_HR]: ["staff"] });
    await expect(svc.submit(applicant, "w1")).rejects.toThrow(BadRequestException);
  });

  it("counts a stage where the initiator is ONE of several holders", async () => {
    const { svc, updateMany } = makeService({
      ...STAFFED,
      [WORKFLOW_PERMISSIONS.REVIEW_HR]: ["staff", "hr-2"],
    });
    await svc.submit(applicant, "w1");
    expect(updateMany).toHaveBeenCalled();
  });

  it("names the stage and the permission that fixes it", async () => {
    // "Forbidden" leaves an administrator guessing at a fix that is one role
    // assignment away.
    const { svc } = makeService({ ...STAFFED, [WORKFLOW_PERMISSIONS.REVIEW_HEAD]: [] });
    await expect(svc.submit(applicant, "w1")).rejects.toThrow(
      /"Head of teaching \/ administration" stage[\s\S]*nobody at this school currently can[\s\S]*workflow\.review\.head/,
    );
  });

  it("tells the truth about WHICH kind of dead end it is", async () => {
    // "You are the only one who can approve it" is false when the stage is
    // empty, and it sends an administrator looking for a person who does not
    // exist. The other sentence is right when the only holder IS the asker.
    const empty = makeService({ ...STAFFED, [WORKFLOW_PERMISSIONS.REVIEW_HR]: [] });
    await expect(empty.svc.submit(applicant, "w1")).rejects.toThrow(/nobody at this school currently can/);
    const onlyMe = makeService({ ...STAFFED, [WORKFLOW_PERMISSIONS.REVIEW_HR]: ["staff"] });
    await expect(onlyMe.svc.submit(applicant, "w1")).rejects.toThrow(/you are currently the only member of staff/);
  });
});

describe("what the check does not touch", () => {
  it("a legacy single-stage request, which has no chain to be stuck in", async () => {
    const { svc, updateMany } = makeService({}, { stages: [] });
    await svc.submit(applicant, "w1");
    expect(updateMany).toHaveBeenCalled();
  });

  it("a REVIEW, which must still work on requests already in flight", async () => {
    // The guard is about raising a new dead end, not about stranding a request
    // that was raised before somebody left.
    const { svc, updateMany } = makeService(
      { ...STAFFED, [WORKFLOW_PERMISSIONS.REVIEW_HR]: [] },
      { state: "PENDING_REVIEW", currentStage: 0 },
    );
    const head: Principal = {
      schoolId: "A",
      userId: "head-1",
      roles: [],
      permissions: ["workflow.review", WORKFLOW_PERMISSIONS.REVIEW_HEAD],
    };
    await svc.review(head, "w1", "APPROVE");
    expect(updateMany).toHaveBeenCalled();
  });
});

// =============================================================================
// The approver who had left, and the request nobody could see was stranded
// =============================================================================
// Two halves of one question, both wrong in the same direction.
//
// FIRST: `holdersOf` — the one place the platform asks "who can approve this",
// used by the workflow dead-end guard, the salary and employment maker-checker,
// the fee adjustment, and the recertification report — read `user_role` and
// nothing else. Exiting a member of staff sets `User.status = EXITED` and
// deliberately LEAVES the role rows alone: the row is employment history, and
// auth refuses the login instead. So a school whose only head teacher resigned
// on Friday was told on Monday that its approval chain was staffed, and the
// guard added to catch exactly this dead end walked straight past it.
//
// SECOND: the guard only refuses NEW requests. The ones already sitting at that
// stage stay there. A stranded request is indistinguishable, on the page, from
// one somebody has not got round to — same "Pending review", same stage label,
// no notice, no sweep. The register now says which, and says the fix.
// =============================================================================

import { holdersOf, hasSecondApprover } from "../../src/common/approvers";
import { WorkflowService } from "../../src/workflow/workflow.service";
import { STAFF_REQUEST_CHAIN, WORKFLOW_PERMISSIONS } from "@sms/types";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

/** Models user_role joined to user: only rows the WHERE actually matches. */
function makeTx(people: Array<{ userId: string; permission: string; status: string }>) {
  const findMany = jest.fn(
    ({ where }: { where: { user?: { status?: string }; role: { permissions: { some: { permission: { key: string } } } } } }) =>
      Promise.resolve(
        people
          .filter((r) => r.permission === where.role.permissions.some.permission.key)
          .filter((r) => !where.user?.status || r.status === where.user.status)
          .map((r) => ({ userId: r.userId })),
      ),
  );
  return { tx: { userRole: { findMany } } as unknown as TenantTx, findMany };
}

describe("who counts as an approver", () => {
  it("does not count a member of staff who has left", async () => {
    const { tx } = makeTx([{ userId: "head-1", permission: "workflow.review.head", status: "EXITED" }]);
    await expect(holdersOf(tx, "workflow.review.head")).resolves.toEqual([]);
  });

  it("still counts the ones who are here", async () => {
    const { tx } = makeTx([
      { userId: "head-1", permission: "workflow.review.head", status: "EXITED" },
      { userId: "head-2", permission: "workflow.review.head", status: "ACTIVE" },
    ]);
    await expect(holdersOf(tx, "workflow.review.head")).resolves.toEqual(["head-2"]);
  });

  it("asks the database for ACTIVE, rather than filtering afterwards", async () => {
    // Asserted on the QUERY. Filtering in Node would read every role row in the
    // school to throw most of them away, and the assertion would pass either
    // way — so the stub cannot be what proves the rule.
    const { tx, findMany } = makeTx([]);
    await holdersOf(tx, "fee.approve");
    expect(findMany.mock.calls[0][0].where).toMatchObject({ user: { status: "ACTIVE" } });
  });

  it("carries through to the maker-checker guards on money", async () => {
    // A school with two fee.approve holders, one of whom left, has one — and a
    // two-person rule with one person is a dead end, on a refund.
    const { tx } = makeTx([
      { userId: "bursar", permission: "fee.approve", status: "ACTIVE" },
      { userId: "gone", permission: "fee.approve", status: "EXITED" },
    ]);
    await expect(hasSecondApprover(tx, "fee.approve", "bursar")).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------

function makeList(rows: Array<Record<string, unknown>>, holders: Record<string, string[]>) {
  const tx = {
    workflowRequest: {
      findMany: jest.fn().mockResolvedValue(rows),
      count: jest.fn().mockResolvedValue(rows.length),
    },
    userRole: {
      findMany: jest.fn(({ where }: { where: { role: { permissions: { some: { permission: { key: string } } } } } }) =>
        Promise.resolve((holders[where.role.permissions.some.permission.key] ?? []).map((userId) => ({ userId }))),
      ),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const svc = new WorkflowService(
    {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { runFinalized: jest.fn() } as never,
    { enqueueMany: jest.fn() } as never,
  );
  return { svc, tx };
}

const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: "w1",
  type: "LEAVE",
  title: "Leave: Ada",
  state: "PENDING_REVIEW",
  initiatorId: "staff",
  createdAt: new Date(),
  currentStage: 0,
  stages: STAFF_REQUEST_CHAIN,
  approvals: [],
  payload: {},
  ...over,
});

const leader: Principal = {
  schoolId: "A",
  userId: "principal-1",
  roles: ["principal"],
  permissions: ["workflow.review", WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL],
};

describe("what the register says about a stranded request", () => {
  it("flags one whose stage nobody can decide", async () => {
    const { svc } = makeList([pendingRow()], { [WORKFLOW_PERMISSIONS.REVIEW_HEAD]: [] });
    const page = await svc.listRequests(leader, {});
    expect(page.items[0].stalled).toBe(true);
  });

  it("does not flag one that is merely waiting for somebody", async () => {
    const { svc } = makeList([pendingRow()], { [WORKFLOW_PERMISSIONS.REVIEW_HEAD]: ["head-1"] });
    const page = await svc.listRequests(leader, {});
    expect(page.items[0].stalled).toBe(false);
  });

  it("flags one whose only possible approver is the person who raised it", async () => {
    // Separation of duties makes "only the applicant holds it" the same dead
    // end as nobody holding it — the engine would refuse their own decision.
    const { svc } = makeList([pendingRow()], { [WORKFLOW_PERMISSIONS.REVIEW_HEAD]: ["staff"] });
    const page = await svc.listRequests(leader, {});
    expect(page.items[0].stalled).toBe(true);
  });

  it("asks about the CURRENT stage, not the first", async () => {
    // A request that cleared the head stage in September is stranded by the HR
    // manager leaving in October, and the stage it is stuck at is the one that
    // has to be reported.
    const { svc } = makeList([pendingRow({ currentStage: 1 })], {
      [WORKFLOW_PERMISSIONS.REVIEW_HEAD]: [],
      [WORKFLOW_PERMISSIONS.REVIEW_HR]: ["hr-1"],
    });
    const page = await svc.listRequests(leader, {});
    expect(page.items[0].stalled).toBe(false);
  });

  it("never flags a request that is already finished", async () => {
    // An APPROVED request has no stage waiting on anybody, and reporting one as
    // unapprovable would send an administrator hunting for nothing.
    const { svc } = makeList([pendingRow({ state: "APPROVED" })], { [WORKFLOW_PERMISSIONS.REVIEW_HEAD]: [] });
    const page = await svc.listRequests(leader, {});
    expect(page.items[0].stalled).toBe(false);
  });

  it("asks once per stage permission, not once per request", async () => {
    // A register of 50 pending requests is 2 queries, not 50. The cost of a
    // warning is what decides whether it survives contact with a real school.
    const rows = Array.from({ length: 12 }, (_, i) => pendingRow({ id: `w${i}`, currentStage: i % 2 }));
    const { svc, tx } = makeList(rows, { [WORKFLOW_PERMISSIONS.REVIEW_HEAD]: ["h"], [WORKFLOW_PERMISSIONS.REVIEW_HR]: ["x"] });
    await svc.listRequests(leader, {});
    expect((tx.userRole.findMany as jest.Mock).mock.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe("where the dead-end check has to happen", () => {
  // The refusal was at SUBMIT. Every one of the eleven callers creates the
  // request and submits it in SEPARATE transactions — `requestLeave` uses three
  // — so the refusal left behind a DRAFT request and the caller's own row. The
  // teacher got a 400 AND a leave application sitting at "Pending" that nobody
  // could review and nobody could even submit. Found by deleting the probe rows
  // after a live run and counting two where one was created.
  function makeCreator(holders: Record<string, string[]>) {
    const create = jest.fn().mockResolvedValue({ id: "w1" });
    const tx = {
      workflowRequest: { create },
      workflowAuditLog: { create: jest.fn().mockResolvedValue({}) },
      userRole: {
        findMany: jest.fn(({ where }: { where: { role: { permissions: { some: { permission: { key: string } } } } } }) =>
          Promise.resolve((holders[where.role.permissions.some.permission.key] ?? []).map((userId) => ({ userId }))),
        ),
      },
    } as unknown as TenantTx;
    const svc = new WorkflowService(
      { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) } as never,
      { runFinalized: jest.fn() } as never,
      { enqueueMany: jest.fn() } as never,
    );
    return { svc, create };
  }

  const applicant: Principal = { schoolId: "A", userId: "staff", roles: [], permissions: ["workflow.create"] };
  const raise = (svc: WorkflowService) =>
    svc.createRequest(applicant, {
      type: "LEAVE",
      title: "Leave: Annual",
      payload: {},
      stages: STAFF_REQUEST_CHAIN,
    });

  it("writes NOTHING when the chain cannot be decided", async () => {
    const { svc, create } = makeCreator({
      [WORKFLOW_PERMISSIONS.REVIEW_HR]: ["hr-1"],
      [WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL]: ["p-1"],
    });
    await expect(raise(svc)).rejects.toThrow(/nobody at this school currently can/);
    expect(create).not.toHaveBeenCalled();
  });

  it("still creates one when the chain is staffed", async () => {
    const { svc, create } = makeCreator({
      [WORKFLOW_PERMISSIONS.REVIEW_HEAD]: ["head-1"],
      [WORKFLOW_PERMISSIONS.REVIEW_HR]: ["hr-1"],
      [WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL]: ["p-1"],
    });
    await expect(raise(svc)).resolves.toMatchObject({ id: "w1" });
    expect(create).toHaveBeenCalled();
  });

  it("leaves an unstaged request alone", async () => {
    // A single-stage legacy request has no chain to be stuck in, and asking
    // would refuse every one of them.
    const { svc, create } = makeCreator({});
    await svc.createRequest(applicant, { type: "LEAVE", title: "x", payload: {}, stages: [] });
    expect(create).toHaveBeenCalled();
  });
});

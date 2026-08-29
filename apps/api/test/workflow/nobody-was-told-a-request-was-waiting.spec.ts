// =============================================================================
// The approval engine told nobody anything
// =============================================================================
// Every maker-checker control on this platform rests on a SECOND person acting:
// leave, grade publication, salary changes, fee schedules, admin appointments,
// stale-register amendments, student exits, invoice waivers. Separation of
// duties is the security property the whole posture is built on.
//
// The engine contained ZERO notification calls. That person was never told a
// request existed. Proven against the running system: a teacher filed a leave
// request, the engine left it PENDING_REVIEW at stage 0, and the notification
// count did not move from 46,317. The approval sat until somebody happened to
// open the approvals page — and the requester was never told the outcome either.
//
// The fix goes on `transition`, the single funnel every action passes through —
// submit, approve, reject, request revision, veto — so one place covers every
// workflow type, including any added later. Notifying from each caller instead
// is how leave ends up covered and student exit does not.
// =============================================================================

import { WorkflowService } from "../../src/workflow/workflow.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const STAGES = [
  { key: "head", label: "Head teacher", permission: "workflow.review.head" },
  { key: "hr", label: "HR manager", permission: "workflow.review.hr" },
];
const INITIATOR = "teacher-1";
const P: Principal = { schoolId: "A", userId: "reviewer-1", roles: ["head_teacher"], permissions: ["workflow.review.head"] };

function make(out: Record<string, unknown>, holders: string[] = ["head-1", "head-2"]) {
  const enqueueMany = jest.fn().mockResolvedValue(undefined);
  const userRole = { findMany: jest.fn().mockResolvedValue(holders.map((userId) => ({ userId }))) };
  const s = Object.create(WorkflowService.prototype) as WorkflowService;
  Object.assign(s, {
    db: {
      runAsTenantReadOnly: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) =>
        fn({ userRole } as unknown as TenantTx),
      ),
    },
    notifications: { enqueueMany },
    logger: { warn: jest.fn() },
  });
  const announce = (s as unknown as { announce: (pr: Principal, o: unknown) => Promise<void> }).announce.bind(s);
  return { announce, enqueueMany, userRole };
}

const base = { id: "wf-1", title: "Annual leave — 2 days", initiatorId: INITIATOR, stages: STAGES, currentStage: 0 };

describe("a request that is now waiting for review", () => {
  it("tells the people who hold the CURRENT stage's permission", async () => {
    const { announce, enqueueMany, userRole } = make({});
    await announce(P, { ...base, state: "PENDING_REVIEW" });
    expect(userRole.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: { permissions: { some: { permission: { key: "workflow.review.head" } } } } },
      }),
    );
    expect(enqueueMany.mock.calls[0][1]).toEqual(["head-1", "head-2"]);
    expect(enqueueMany.mock.calls[0][2]).toMatchObject({ title: "A request is waiting for your approval" });
  });

  it("asks for the SECOND stage's permission once the first has approved", async () => {
    // A staged chain advances the pointer and stays PENDING_REVIEW. Telling stage
    // one again would be worse than silence: it points at a button they have
    // already pressed.
    const { announce, userRole } = make({});
    await announce(P, { ...base, state: "PENDING_REVIEW", currentStage: 1 });
    expect(userRole.findMany.mock.calls[0][0]).toMatchObject({
      where: { role: { permissions: { some: { permission: { key: "workflow.review.hr" } } } } },
    });
  });

  it("NEVER tells the initiator to approve their own request", async () => {
    // Separation of duties: the engine refuses it, so inviting them would be
    // telling somebody to attempt something that cannot work.
    const { announce, enqueueMany } = make({}, ["head-1", INITIATOR]);
    await announce(P, { ...base, state: "PENDING_REVIEW" });
    expect(enqueueMany.mock.calls[0][1]).toEqual(["head-1"]);
  });

  it("tells only the NAMED approver on an initiator-routed chain", async () => {
    // That chain lets one person and no other act. Telling every permission
    // holder would point most of them at a request they cannot touch.
    const { announce, enqueueMany, userRole } = make({});
    await announce(P, {
      ...base,
      state: "PENDING_REVIEW",
      stages: [{ key: "s1", label: "Named", permission: "workflow.review", approverId: "chosen-1" }],
    });
    expect(userRole.findMany).not.toHaveBeenCalled();
    expect(enqueueMany.mock.calls[0][1]).toEqual(["chosen-1"]);
  });

  it("falls back to workflow.review for the legacy single-stage shape", async () => {
    // An empty chain is the documented back-compat form and must still reach
    // somebody.
    const { announce, userRole } = make({});
    await announce(P, { ...base, state: "PENDING_REVIEW", stages: [] });
    expect(userRole.findMany.mock.calls[0][0]).toMatchObject({
      where: { role: { permissions: { some: { permission: { key: "workflow.review" } } } } },
    });
  });

  it("sends nothing when the school has nobody who can review it", async () => {
    const { announce, enqueueMany } = make({}, []);
    await announce(P, { ...base, state: "PENDING_REVIEW" });
    expect(enqueueMany).not.toHaveBeenCalled();
  });
});

describe("a request that has been decided", () => {
  it.each([
    ["APPROVED", "Your request was approved"],
    ["REJECTED", "Your request was rejected"],
    // REVISION_REQUESTED, not DRAFT. This row used to say DRAFT — a state
    // `WORKFLOW_TRANSITIONS` cannot produce — so it pinned an unreachable branch
    // and made the suite look as though "sent back for changes" was covered,
    // while the state a reviewer actually creates was announced by nothing.
    // Measured live: a head teacher sent a staff request back and the
    // initiator's notification count did not move.
    ["REVISION_REQUESTED", "Your request was sent back for changes"],
  ])("tells the person who raised it: %s", async (state, title) => {
    const { announce, enqueueMany } = make({});
    await announce(P, { ...base, state });
    expect(enqueueMany.mock.calls[0][1]).toEqual([INITIATOR]);
    expect(enqueueMany.mock.calls[0][2]).toMatchObject({ title });
  });

  it("says nothing when the initiator is the one who acted", async () => {
    // Submitting your own request moves it to PENDING_REVIEW; withdrawing or
    // revising it yourself needs no announcement back to yourself.
    const self: Principal = { ...P, userId: INITIATOR };
    const { announce, enqueueMany } = make({});
    // Also REVISION_REQUESTED: with DRAFT this passed vacuously, since the
    // branch it fell through was never entered for any reason.
    await announce(self, { ...base, state: "REVISION_REQUESTED" });
    expect(enqueueMany).not.toHaveBeenCalled();
  });
});

describe("the notice itself", () => {
  it("names the request and carries its id, and nothing else", async () => {
    // A workflow payload can hold a salary or a child's marks. The notice is a
    // pointer to a request, not a summary of it.
    const { announce, enqueueMany } = make({});
    await announce(P, { ...base, state: "PENDING_REVIEW" });
    const msg = enqueueMany.mock.calls[0][2] as { body: string; data: Record<string, unknown> };
    expect(msg.body).toBe("Annual leave — 2 days");
    expect(msg.data).toEqual({ requestId: "wf-1" });
  });

  it("never lets a failed notice undo a transition", async () => {
    // The transition is already committed. This runs outside it precisely so a
    // queue outage cannot roll back an approval.
    const { announce, enqueueMany } = make({});
    enqueueMany.mockRejectedValue(new Error("queue down"));
    await expect(announce(P, { ...base, state: "PENDING_REVIEW" })).resolves.toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// The WIRING, not just the function.
//
// Every test above calls `announce` directly, so all of them pass with the call
// removed from `transition` — which is precisely how a working function ends up
// connected to nothing. Verified: deleting `await this.announce(p, out)` left
// the suite green until this case existed.
// -----------------------------------------------------------------------------
describe("a real transition", () => {
  it("submits, and the reviewers are told", async () => {
    const enqueueMany = jest.fn().mockResolvedValue(undefined);
    const request = {
      id: "wf-1",
      type: "LEAVE",
      title: "Annual leave — 2 days",
      state: "DRAFT",
      initiatorId: INITIATOR,
      payload: {},
      stages: STAGES,
      currentStage: 0,
      approvals: [],
      createdAt: new Date(),
    };
    const tx = {
      workflowRequest: {
        findFirst: jest.fn().mockResolvedValue(request),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      workflowAuditLog: { create: jest.fn().mockResolvedValue({}) },
      userRole: { findMany: jest.fn().mockResolvedValue([{ userId: "head-1" }]) },
    } as unknown as TenantTx;
    const svc = new WorkflowService(
      {
        runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
        runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      } as never,
      { onFinalized: jest.fn(), runFinalized: jest.fn().mockResolvedValue(undefined) } as never,
      { enqueueMany } as never,
    );
    const initiator: Principal = { schoolId: "A", userId: INITIATOR, roles: ["teacher"], permissions: ["workflow.create"] };
    await svc.submit(initiator, "wf-1");
    expect(enqueueMany).toHaveBeenCalledTimes(1);
    expect(enqueueMany.mock.calls[0][1]).toEqual(["head-1"]);
  });
});

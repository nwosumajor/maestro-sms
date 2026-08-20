// =============================================================================
// An approvals page that invited people to be refused
// =============================================================================
// The list is the whole tenant's register by design — leadership should see what
// is in flight. But the page is titled "Everything waiting on you", and it
// offered Approve / Reject / Request revision on EVERY pending row to anyone
// holding the generic `workflow.review`.
//
// The engine decides by four narrower rules: the current stage's GRANULAR
// permission, not being the initiator, not having already acted at an earlier
// stage, and — for a routed stage — being the named approver unless they have
// left. None of that reached the client, because the DTO carried no stage
// permission at all.
//
// Seen live: a school_admin's inbox listed a leave request sitting at the
// PRINCIPAL stage with all three buttons, and pressing one returned
//
//     403  You are not the Principal (final) approver
//
// So `awaitingMe` is computed on the server, which is also the only side that
// knows about an ELEVATION grant — not derivable from the caller's roles.
//
// The rule is shared with the engine, and the test that matters is the LAST
// one: it drives the real `review()` over the same matrix and asserts the
// predicate agrees with it case by case. A second implementation of "who may
// act" that quietly disagrees is exactly the defect this field exists to cure.
// =============================================================================

import { canDecideWorkflowNow, STAFF_REQUEST_CHAIN, WORKFLOW_PERMISSIONS } from "@sms/types";
import { WorkflowService } from "../../src/workflow/workflow.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const HEAD = WORKFLOW_PERMISSIONS.REVIEW_HEAD;
const PRINCIPAL = WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL;
const REVIEW = WORKFLOW_PERMISSIONS.REVIEW;

const req = (over: Record<string, unknown> = {}) => ({
  state: "PENDING_REVIEW",
  initiatorId: "staff",
  currentStage: 0,
  stages: STAFF_REQUEST_CHAIN,
  approvals: [],
  ...over,
});
const actor = (permissions: string[], userId = "me") => ({ userId, permissions });

describe("who the page may offer a decision to", () => {
  it("the holder of the CURRENT stage's permission", () => {
    expect(canDecideWorkflowNow(req(), actor([REVIEW, HEAD]))).toBe(true);
  });

  it("not the holder of a LATER stage's permission", () => {
    // The exact live case: a school_admin at the principal stage of someone
    // else's chain, invited to approve and refused.
    expect(canDecideWorkflowNow(req({ currentStage: 2 }), actor([REVIEW, HEAD]))).toBe(false);
    expect(canDecideWorkflowNow(req({ currentStage: 2 }), actor([REVIEW, PRINCIPAL]))).toBe(true);
  });

  it("not the initiator, whatever they hold", () => {
    expect(canDecideWorkflowNow(req(), actor([REVIEW, HEAD], "staff"))).toBe(false);
  });

  it("not somebody who already decided an earlier stage", () => {
    // Separation of duties across the whole chain, not just per stage.
    const twice = req({ currentStage: 2, approvals: [{ stageKey: "HEAD", approverId: "me", at: "x" }] });
    expect(canDecideWorkflowNow(twice, actor([REVIEW, PRINCIPAL]))).toBe(false);
  });

  it("nobody, once the request is terminal", () => {
    for (const state of ["APPROVED", "REJECTED", "DRAFT", "REVISION_REQUESTED"]) {
      expect(canDecideWorkflowNow(req({ state }), actor([REVIEW, HEAD]))).toBe(false);
    }
  });

  it("only the named approver on a ROUTED stage", () => {
    const routed = req({ stages: [{ ...STAFF_REQUEST_CHAIN[0], approverId: "chosen" }] });
    expect(canDecideWorkflowNow(routed, actor([REVIEW, HEAD]))).toBe(false);
    expect(canDecideWorkflowNow(routed, actor([REVIEW, HEAD], "chosen"))).toBe(true);
  });

  it("anyone eligible once the named approver has LEFT", () => {
    // The engine's self-healing fallback, or a routed stage would deadlock
    // forever when its one person leaves.
    const routed = req({ stages: [{ ...STAFF_REQUEST_CHAIN[0], approverId: "gone" }] });
    expect(canDecideWorkflowNow(routed, actor([REVIEW, HEAD]), false)).toBe(true);
  });

  it("the generic reviewer on a legacy single-stage request", () => {
    expect(canDecideWorkflowNow(req({ stages: [] }), actor([REVIEW]))).toBe(true);
    expect(canDecideWorkflowNow(req({ stages: [] }), actor([]))).toBe(false);
  });

  it("someone whose authority is an ELEVATION grant", () => {
    // The guard merges an active grant into `permissions` before anything reads
    // it, so borrowed authority is not a special case here — and this is the
    // reason the flag cannot be computed in the browser, which sees roles.
    expect(canDecideWorkflowNow(req({ currentStage: 2 }), actor([REVIEW, PRINCIPAL]))).toBe(true);
  });
});

// -----------------------------------------------------------------------------

function makeService(request: Record<string, unknown>) {
  const tx = {
    workflowRequest: {
      findFirst: jest.fn().mockResolvedValue({ id: "w1", type: "LEAVE", title: "t", payload: {}, ...request }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    workflowAuditLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    // The routed-approver lookup: present unless the case says otherwise.
    user: { findFirst: jest.fn().mockResolvedValue({ id: "chosen", status: "ACTIVE" }), findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  return new WorkflowService(
    db as never,
    { runFinalized: jest.fn().mockResolvedValue(undefined) } as never,
    { enqueueMany: jest.fn().mockResolvedValue(undefined) } as never,
  );
}

describe("the page's answer and the engine's answer", () => {
  const CASES: Array<{ name: string; request: Record<string, unknown>; permissions: string[]; userId?: string; namedActive?: boolean }> = [
    { name: "right stage", request: req(), permissions: [REVIEW, HEAD] },
    { name: "wrong stage", request: req({ currentStage: 2 }), permissions: [REVIEW, HEAD] },
    { name: "final stage, right permission", request: req({ currentStage: 2 }), permissions: [REVIEW, PRINCIPAL] },
    { name: "initiator", request: req(), permissions: [REVIEW, HEAD], userId: "staff" },
    {
      name: "already acted earlier",
      request: req({ currentStage: 2, approvals: [{ stageKey: "HEAD", approverId: "me", at: "x" }] }),
      permissions: [REVIEW, PRINCIPAL],
    },
    { name: "no granular permission at all", request: req(), permissions: [REVIEW] },
    {
      name: "routed elsewhere, approver present",
      request: req({ stages: [{ ...STAFF_REQUEST_CHAIN[0], approverId: "chosen" }] }),
      permissions: [REVIEW, HEAD],
    },
    { name: "legacy single-stage", request: req({ stages: [] }), permissions: [REVIEW] },
  ];

  it.each(CASES)("agree on: $name", async ({ request, permissions, userId, namedActive }) => {
    const p: Principal = { schoolId: "A", userId: userId ?? "me", roles: [], permissions };
    const predicted = canDecideWorkflowNow(
      request as Parameters<typeof canDecideWorkflowNow>[0],
      p,
      namedActive ?? true,
    );
    let engineAllowed = true;
    try {
      await makeService(request).review(p, "w1", "APPROVE");
    } catch {
      engineAllowed = false;
    }
    expect(predicted).toBe(engineAllowed);
  });
});

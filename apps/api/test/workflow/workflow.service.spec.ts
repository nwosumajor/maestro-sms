// =============================================================================
// WorkflowService — state machine + separation-of-duties unit tests
// =============================================================================

import { WorkflowService } from "../../src/workflow/workflow.service";
import { STAFF_REQUEST_CHAIN, canInitiateWorkflowType } from "@sms/types";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(request: Record<string, unknown> | null) {
  const update = jest.fn().mockResolvedValue({});
  // Optimistic-concurrency guard: the transition writes via updateMany and
  // requires count>0 (the row was still in the read state). Model a successful
  // guarded write.
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const auditCreate = jest.fn().mockResolvedValue({});
  const tx = {
    workflowRequest: {
      findFirst: jest.fn().mockResolvedValue(request),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: "w1", ...data }),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      update,
      updateMany,
    },
    workflowAuditLog: {
      create: auditCreate,
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const hooks = { onFinalized: jest.fn(), runFinalized: jest.fn().mockResolvedValue(undefined) };
  return { service: new WorkflowService(db as never, hooks as never), update, updateMany, auditCreate, hooks };
}

const p = (permissions: string[], userId = "me"): Principal => ({
  schoolId: "A",
  userId,
  roles: [],
  permissions,
});

describe("WorkflowService state machine", () => {
  it("create starts in DRAFT and logs the creation", async () => {
    const { service, auditCreate } = makeService(null);
    const req = (await service.createRequest(p(["workflow.create"]), {
      type: "LEAVE",
      title: "Annual leave",
      payload: { days: 3 },
    })) as { state: string };
    expect(req.state).toBe("DRAFT");
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ newState: "DRAFT" }) }),
    );
  });

  it("initiator submits: DRAFT -> PENDING_REVIEW", async () => {
    const { service, updateMany } = makeService({ id: "w1", state: "DRAFT", initiatorId: "me" });
    const r = (await service.submit(p(["workflow.create"], "me"), "w1")) as { state: string };
    expect(r.state).toBe("PENDING_REVIEW");
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "PENDING_REVIEW" }) }),
    );
  });

  it("reviewer approves: PENDING_REVIEW -> APPROVED (audited with approverId)", async () => {
    const { service, auditCreate } = makeService({
      id: "w1",
      state: "PENDING_REVIEW",
      initiatorId: "someone-else",
    });
    const r = (await service.review(p(["workflow.review"], "reviewer"), "w1", "APPROVE", "ok")) as {
      state: string;
    };
    expect(r.state).toBe("APPROVED");
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          oldState: "PENDING_REVIEW",
          newState: "APPROVED",
          approverId: "reviewer",
        }),
      }),
    );
  });

  it("separation of duties: a reviewer cannot review their OWN request", async () => {
    const { service } = makeService({ id: "w1", state: "PENDING_REVIEW", initiatorId: "me" });
    await expect(
      service.review(p(["workflow.review"], "me"), "w1", "APPROVE"),
    ).rejects.toThrow(/cannot review your own/i);
  });

  it("illegal transition is rejected: APPROVE from DRAFT -> 409", async () => {
    const { service } = makeService({ id: "w1", state: "DRAFT", initiatorId: "other" });
    await expect(
      service.review(p(["workflow.review"], "reviewer"), "w1", "APPROVE"),
    ).rejects.toThrow(/cannot approve from draft/i);
  });

  it("board veto: APPROVED -> REJECTED", async () => {
    const { service } = makeService({ id: "w1", state: "APPROVED", initiatorId: "other" });
    const r = (await service.veto(p(["workflow.veto"], "board"), "w1", "overridden")) as {
      state: string;
    };
    expect(r.state).toBe("REJECTED");
  });

  it("submit by a non-initiator is 404 (no existence leak)", async () => {
    const { service } = makeService({ id: "w1", state: "DRAFT", initiatorId: "owner" });
    await expect(service.submit(p(["workflow.create"], "intruder"), "w1")).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("canInitiateWorkflowType (per-type initiation rules)", () => {
  const staff = ["workflow.create"];
  it("any staff can initiate LEAVE and STAFF_REQUEST", () => {
    expect(canInitiateWorkflowType("LEAVE", staff)).toBe(true);
    expect(canInitiateWorkflowType("STAFF_REQUEST", staff)).toBe(true);
  });
  it("PURCHASE_ORDER needs fee.manage; DISCIPLINARY needs rbac.manage", () => {
    expect(canInitiateWorkflowType("PURCHASE_ORDER", staff)).toBe(false);
    expect(canInitiateWorkflowType("PURCHASE_ORDER", [...staff, "fee.manage"])).toBe(true);
    expect(canInitiateWorkflowType("DISCIPLINARY", staff)).toBe(false);
    expect(canInitiateWorkflowType("DISCIPLINARY", [...staff, "rbac.manage"])).toBe(true);
  });
  it("LMS_CONTENT_PUBLISH is system-only — never initiable via the API", () => {
    expect(canInitiateWorkflowType("LMS_CONTENT_PUBLISH", [...staff, "fee.manage", "rbac.manage"])).toBe(false);
  });
  it("a non-staff principal (no workflow.create) can initiate nothing", () => {
    expect(canInitiateWorkflowType("STAFF_REQUEST", [])).toBe(false);
  });
});

describe("WorkflowService multi-stage chain (head -> HR -> principal)", () => {
  const staged = (over: Record<string, unknown> = {}) => ({
    id: "w1",
    type: "LEAVE",
    state: "PENDING_REVIEW",
    initiatorId: "staff",
    payload: {},
    stages: STAFF_REQUEST_CHAIN,
    currentStage: 0,
    approvals: [],
    ...over,
  });

  it("stage-1 (HEAD) approve advances the pointer and stays PENDING_REVIEW (not finalized)", async () => {
    const { service, updateMany, hooks } = makeService(staged());
    const r = (await service.review(p(["workflow.review", "workflow.review.head"], "head1"), "w1", "APPROVE")) as {
      state: string;
      currentStage: number;
    };
    expect(r.state).toBe("PENDING_REVIEW");
    expect(r.currentStage).toBe(1);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "PENDING_REVIEW", currentStage: 1 }) }),
    );
    expect(hooks.runFinalized).not.toHaveBeenCalled(); // not terminal yet
  });

  it("the wrong-stage approver is rejected (HR can't approve the HEAD stage)", async () => {
    const { service } = makeService(staged({ currentStage: 0 }));
    await expect(
      service.review(p(["workflow.review", "workflow.review.hr"], "hr1"), "w1", "APPROVE"),
    ).rejects.toThrow(/not the .* approver/i);
  });

  it("final stage (PRINCIPAL) approve finalizes to APPROVED and fires the finalized hook", async () => {
    const { service, hooks } = makeService(
      staged({ currentStage: 2, approvals: [{ stageKey: "HEAD", approverId: "head1", at: "t" }, { stageKey: "HR", approverId: "hr1", at: "t" }] }),
    );
    const r = (await service.review(p(["workflow.review", "workflow.review.principal"], "principal1"), "w1", "APPROVE")) as {
      state: string;
    };
    expect(r.state).toBe("APPROVED");
    expect(hooks.runFinalized).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "LEAVE", state: "APPROVED" }),
    );
  });

  it("a user who already approved an earlier stage cannot approve a later one", async () => {
    const { service } = makeService(
      staged({ currentStage: 1, approvals: [{ stageKey: "HEAD", approverId: "super", at: "t" }] }),
    );
    // 'super' holds every granular perm but already acted at the HEAD stage.
    await expect(
      service.review(
        p(["workflow.review", "workflow.review.head", "workflow.review.hr", "workflow.review.principal"], "super"),
        "w1",
        "APPROVE",
      ),
    ).rejects.toThrow(/already acted/i);
  });
});

describe("WorkflowService initiator-routed chains (named approvers)", () => {
  // Harness with a user model so buildCustomChain / listEligibleApprovers work.
  function makeRoutedService(request: Record<string, unknown> | null, eligibleUsers: { id: string; name: string }[]) {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      workflowRequest: {
        findFirst: jest.fn().mockResolvedValue(request),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "w1", ...data })),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany,
      },
      workflowAuditLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue(eligibleUsers) },
    } as unknown as TenantTx;
    const db = { runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    const hooks = { onFinalized: jest.fn(), runFinalized: jest.fn().mockResolvedValue(undefined) };
    return { service: new WorkflowService(db as never, hooks as never), updateMany };
  }

  const routedStages = [
    { key: "ROUTE_1", label: "Head One", permission: "workflow.review", approverId: "senior1", approverName: "Head One" },
    { key: "ROUTE_2", label: "Prin Two", permission: "workflow.review", approverId: "senior2", approverName: "Prin Two" },
  ];
  const routed = (over: Record<string, unknown> = {}) => ({
    id: "w1",
    type: "STAFF_REQUEST",
    state: "PENDING_REVIEW",
    initiatorId: "staff",
    payload: {},
    stages: routedStages,
    currentStage: 0,
    approvals: [],
    ...over,
  });

  it("create with approverIds builds a named 2-stage chain in the picked order", async () => {
    const { service } = makeRoutedService(null, [
      { id: "senior1", name: "Head One" },
      { id: "senior2", name: "Prin Two" },
    ]);
    const req = (await service.createRequest(p(["workflow.create"], "staff"), {
      type: "STAFF_REQUEST",
      title: "Routed",
      payload: {},
      approverIds: ["senior1", "senior2"],
    })) as unknown as { stages: { key: string; approverId: string; approverName: string }[] };
    expect(req.stages.map((s) => s.approverId)).toEqual(["senior1", "senior2"]);
    expect(req.stages.map((s) => s.approverName)).toEqual(["Head One", "Prin Two"]);
  });

  it("routing to yourself is rejected", async () => {
    const { service } = makeRoutedService(null, []);
    await expect(
      service.createRequest(p(["workflow.create"], "staff"), {
        type: "STAFF_REQUEST", title: "x", payload: {}, approverIds: ["staff", "senior2"],
      }),
    ).rejects.toThrow(/yourself/i);
  });

  it("duplicate approvers are rejected", async () => {
    const { service } = makeRoutedService(null, []);
    await expect(
      service.createRequest(p(["workflow.create"], "staff"), {
        type: "STAFF_REQUEST", title: "x", payload: {}, approverIds: ["senior1", "senior1"],
      }),
    ).rejects.toThrow(/different person/i);
  });

  it("a pick who is not reviewer-capable is rejected", async () => {
    // Only senior1 resolves as eligible; senior2 (a plain teacher) does not.
    const { service } = makeRoutedService(null, [{ id: "senior1", name: "Head One" }]);
    await expect(
      service.createRequest(p(["workflow.create"], "staff"), {
        type: "STAFF_REQUEST", title: "x", payload: {}, approverIds: ["senior1", "senior2"],
      }),
    ).rejects.toThrow(/senior staff member with review rights/i);
  });

  it("only the NAMED stage approver can act — another reviewer is refused", async () => {
    const { service } = makeRoutedService(routed(), []);
    await expect(
      service.review(p(["workflow.review"], "some-other-reviewer"), "w1", "APPROVE"),
    ).rejects.toThrow(/routed to Head One/i);
  });

  it("the named approver advances the chain to the next named stage", async () => {
    const { service, updateMany } = makeRoutedService(routed(), []);
    const r = (await service.review(p(["workflow.review"], "senior1"), "w1", "APPROVE")) as {
      state: string; currentStage: number;
    };
    expect(r.state).toBe("PENDING_REVIEW");
    expect(r.currentStage).toBe(1);
    expect(updateMany).toHaveBeenCalled();
  });

  it("a bystander reviewer cannot REQUEST_REVISION on a routed stage either", async () => {
    const { service } = makeRoutedService(routed(), []);
    await expect(
      service.review(p(["workflow.review"], "bystander"), "w1", "REQUEST_REVISION"),
    ).rejects.toThrow(/routed to Head One/i);
  });

  it("the second named approver finalizes at their stage", async () => {
    const { service } = makeRoutedService(
      routed({ currentStage: 1, approvals: [{ stageKey: "ROUTE_1", approverId: "senior1", at: "t" }] }),
      [],
    );
    const r = (await service.review(p(["workflow.review"], "senior2"), "w1", "APPROVE")) as { state: string };
    expect(r.state).toBe("APPROVED");
  });
});

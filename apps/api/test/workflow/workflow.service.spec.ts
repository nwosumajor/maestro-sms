// =============================================================================
// WorkflowService — state machine + separation-of-duties unit tests
// =============================================================================

import { WorkflowService } from "../../src/workflow/workflow.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(request: Record<string, unknown> | null) {
  const update = jest.fn().mockResolvedValue({});
  const auditCreate = jest.fn().mockResolvedValue({});
  const tx = {
    workflowRequest: {
      findFirst: jest.fn().mockResolvedValue(request),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: "w1", ...data }),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      update,
    },
    workflowAuditLog: {
      create: auditCreate,
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  return { service: new WorkflowService(db as never), update, auditCreate };
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
    const { service, update } = makeService({ id: "w1", state: "DRAFT", initiatorId: "me" });
    const r = (await service.submit(p(["workflow.create"], "me"), "w1")) as { state: string };
    expect(r.state).toBe("PENDING_REVIEW");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { state: "PENDING_REVIEW" } }),
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

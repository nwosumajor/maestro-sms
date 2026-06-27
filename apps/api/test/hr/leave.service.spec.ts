// =============================================================================
// LeaveService — request routing + the finalized-hook balance logic
// =============================================================================

import { LeaveService } from "../../src/hr/leave.service";
import type { FinalizedRequest } from "../../src/workflow/workflow-hooks.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(over: {
  leaveType?: Record<string, unknown> | null;
  leaveTypes?: Array<Record<string, unknown>>;
  balances?: Array<Record<string, unknown>>;
  balance?: Record<string, unknown> | null;
  leaveRequest?: Record<string, unknown> | null;
} = {}) {
  const leaveBalanceCreate = jest.fn().mockResolvedValue({});
  const leaveBalanceUpdate = jest.fn().mockResolvedValue({});
  const leaveRequestUpdate = jest.fn().mockResolvedValue({});
  const leaveRequestCreate = jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "lr1", ...data }));
  const tx = {
    leaveType: {
      findFirst: jest.fn().mockResolvedValue(over.leaveType ?? null),
      findMany: jest.fn().mockResolvedValue(over.leaveTypes ?? []),
    },
    leaveBalance: {
      findMany: jest.fn().mockResolvedValue(over.balances ?? []),
      findFirst: jest.fn().mockResolvedValue(over.balance ?? null),
      create: leaveBalanceCreate,
      update: leaveBalanceUpdate,
    },
    leaveRequest: {
      findFirst: jest.fn().mockResolvedValue(over.leaveRequest ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      create: leaveRequestCreate,
      update: leaveRequestUpdate,
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const workflow = { createRequest: jest.fn().mockResolvedValue({ id: "wf1" }), submit: jest.fn().mockResolvedValue({}) };
  let captured: ((tx: TenantTx, req: FinalizedRequest) => Promise<void>) | undefined;
  const hooks = { onFinalized: jest.fn((h: never) => { captured = h; }), runFinalized: jest.fn() };
  const service = new LeaveService(db as never, audit as never, workflow as never, hooks as never);
  return { service, tx, workflow, audit, leaveRequestCreate, leaveRequestUpdate, leaveBalanceCreate, leaveBalanceUpdate, getHook: () => captured };
}

const p = (userId = "staff"): Principal => ({ schoolId: "A", userId, roles: [], permissions: [] });
const finalized = (state: "APPROVED" | "REJECTED"): FinalizedRequest => ({
  id: "wf1", schoolId: "A", type: "LEAVE", state, payload: {}, initiatorId: "staff",
});

describe("LeaveService", () => {
  it("requestLeave routes through the 3-stage chain and creates a PENDING leave row", async () => {
    const { service, workflow, leaveRequestCreate } = makeService({ leaveType: { id: "t1", name: "Annual" } });
    await service.requestLeave(p(), { leaveTypeId: "t1", startDate: "2026-02-01", endDate: "2026-02-03", days: 3 });
    expect(workflow.createRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "LEAVE", stages: expect.arrayContaining([expect.objectContaining({ key: "HEAD" })]) }),
    );
    expect(leaveRequestCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PENDING", workflowRequestId: "wf1" }) }),
    );
    expect(workflow.submit).toHaveBeenCalledWith(expect.anything(), "wf1");
  });

  it("requestLeave rejects an unknown leave type (404) and non-positive days (400)", async () => {
    const missing = makeService({ leaveType: null });
    await expect(
      missing.service.requestLeave(p(), { leaveTypeId: "x", startDate: "2026-02-01", endDate: "2026-02-03", days: 3 }),
    ).rejects.toThrow(/not found/i);
    const bad = makeService({ leaveType: { id: "t1", name: "Annual" } });
    await expect(
      bad.service.requestLeave(p(), { leaveTypeId: "t1", startDate: "2026-02-01", endDate: "2026-02-03", days: 0 }),
    ).rejects.toThrow(/positive/i);
  });

  it("myBalances synthesises a full-entitlement row when none exists yet", async () => {
    const { service } = makeService({ leaveTypes: [{ id: "t1", name: "Annual", daysPerYear: 20 }], balances: [] });
    const res = await service.myBalances(p());
    expect(res[0]).toMatchObject({ leaveTypeName: "Annual", entitledDays: 20, usedDays: 0, remainingDays: 20 });
  });

  it("the finalized hook marks APPROVED and decrements the balance (in-tx)", async () => {
    const { service, tx, getHook, leaveRequestUpdate, leaveBalanceCreate } = makeService({
      leaveType: { id: "t1", daysPerYear: 20 },
      leaveRequest: { id: "lr1", status: "PENDING", userId: "staff", leaveTypeId: "t1", days: 3, startDate: new Date("2026-02-01") },
      balance: null,
    });
    service.onModuleInit();
    await getHook()!(tx, finalized("APPROVED"));
    expect(leaveRequestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "APPROVED" } }));
    expect(leaveBalanceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ usedDays: 3 }) }),
    );
  });

  it("the finalized hook is idempotent: a non-PENDING row is left untouched", async () => {
    const { service, tx, getHook, leaveRequestUpdate } = makeService({
      leaveRequest: { id: "lr1", status: "APPROVED", userId: "staff", leaveTypeId: "t1", days: 3, startDate: new Date("2026-02-01") },
    });
    service.onModuleInit();
    await getHook()!(tx, finalized("REJECTED"));
    expect(leaveRequestUpdate).not.toHaveBeenCalled();
  });
});

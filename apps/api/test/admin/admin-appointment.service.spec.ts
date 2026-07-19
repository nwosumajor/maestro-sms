// =============================================================================
// AdminService — ADMIN_APPOINTMENT maker-checker (junior-admin tier)
// =============================================================================
// Appointing a junior_admin — or stacking further roles onto one — must never
// be a single senior's direct act: assignRole raises an ADMIN_APPOINTMENT
// workflow request instead, and the grant lands only via the finalized hook
// after a DIFFERENT workflow.review holder approves. Ordinary grants to
// ordinary users stay direct. The hook itself is idempotent and no-ops for
// rejected / foreign requests.

import { AdminService } from "../../src/admin/admin.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";
import type { FinalizedRequest } from "../../src/workflow/workflow-hooks.service";

function makeService(over: { targetHoldsJunior?: boolean; role?: { id: string } | null; user?: { id: string; name: string } | null } = {}) {
  const upsert = jest.fn().mockResolvedValue({ id: "ur1" });
  const tx = {
    role: { findFirst: jest.fn().mockResolvedValue(over.role === undefined ? { id: "r1" } : over.role) },
    user: {
      findFirst: jest.fn().mockResolvedValue(over.user === undefined ? { id: "u-2", name: "Target" } : over.user),
    },
    userRole: {
      findFirst: jest.fn().mockResolvedValue(over.targetHoldsJunior ? { id: "ur-j" } : null),
      upsert,
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const workflow = {
    createRequest: jest.fn().mockResolvedValue({ id: "wf-1" }),
    submit: jest.fn().mockResolvedValue({ id: "wf-1", state: "PENDING_REVIEW" }),
  };
  let finalized: ((t: TenantTx, req: FinalizedRequest) => Promise<void>) | undefined;
  const hooks = { onFinalized: (h: (t: TenantTx, req: FinalizedRequest) => Promise<void>) => (finalized = h) };
  const service = new AdminService(db as never, audit as never, workflow as never, hooks as never);
  return { service, tx, upsert, audit, workflow, runHook: (req: FinalizedRequest) => finalized!(tx, req) };
}

const senior: Principal = { schoolId: "A", userId: "admin-1", roles: ["school_admin"], permissions: ["rbac.manage"] };

describe("AdminService ADMIN_APPOINTMENT maker-checker", () => {
  it("assigning junior_admin raises a workflow request instead of granting directly", async () => {
    const { service, upsert, workflow } = makeService();
    const res = await service.assignRole(senior, "u-2", "junior_admin");
    expect(res).toMatchObject({ pendingApproval: true, requestId: "wf-1", roleName: "junior_admin" });
    expect(workflow.createRequest).toHaveBeenCalledWith(
      senior,
      expect.objectContaining({ type: "ADMIN_APPOINTMENT", payload: { userId: "u-2", roleName: "junior_admin" } }),
    );
    expect(workflow.submit).toHaveBeenCalledWith(senior, "wf-1");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("granting ANY further role to a user who holds junior_admin is also maker-checker", async () => {
    const { service, upsert, workflow } = makeService({ targetHoldsJunior: true });
    const res = await service.assignRole(senior, "u-2", "librarian");
    expect(res).toMatchObject({ pendingApproval: true, roleName: "librarian" });
    expect(workflow.createRequest).toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("an ordinary grant to an ordinary user stays direct and audited", async () => {
    const { service, upsert, workflow, audit } = makeService();
    await service.assignRole(senior, "u-2", "librarian");
    expect(upsert).toHaveBeenCalled();
    expect(workflow.createRequest).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "rbac.role.assign" }),
      expect.anything(),
    );
  });

  it("the APPROVED hook applies the grant in-tx, attributed to the initiator", async () => {
    const { upsert, audit, runHook } = makeService();
    await runHook({
      id: "wf-1",
      schoolId: "A",
      type: "ADMIN_APPOINTMENT",
      state: "APPROVED",
      payload: { userId: "u-2", roleName: "junior_admin" },
      initiatorId: "admin-1",
    });
    expect(upsert).toHaveBeenCalledWith({
      where: { userId_roleId: { userId: "u-2", roleId: "r1" } },
      update: {},
      create: { schoolId: "A", userId: "u-2", roleId: "r1" },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-1",
        action: "rbac.role.assign",
        metadata: expect.objectContaining({ makerChecker: true, workflowRequestId: "wf-1" }),
      }),
      expect.anything(),
    );
  });

  it("a REJECTED (or foreign-type) finalization grants nothing", async () => {
    const { upsert, runHook } = makeService();
    await runHook({ id: "wf-1", schoolId: "A", type: "ADMIN_APPOINTMENT", state: "REJECTED", payload: { userId: "u-2", roleName: "junior_admin" }, initiatorId: "admin-1" });
    await runHook({ id: "wf-2", schoolId: "A", type: "LEAVE", state: "APPROVED", payload: {}, initiatorId: "admin-1" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("the hook refuses a smuggled super_admin payload (defense in depth)", async () => {
    const { upsert, runHook } = makeService();
    await runHook({ id: "wf-1", schoolId: "A", type: "ADMIN_APPOINTMENT", state: "APPROVED", payload: { userId: "u-2", roleName: "super_admin" }, initiatorId: "admin-1" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("createUser with junior_admin creates a ROLE-LESS account + raises the request", async () => {
    const userRoleCreate = jest.fn();
    const tx = {
      role: { findFirst: jest.fn().mockResolvedValue({ id: "r1" }) },
      user: {
        findFirst: jest.fn().mockResolvedValue(null), // duplicate-email check misses
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "new-u", ...data })),
      },
      userRole: { findFirst: jest.fn().mockResolvedValue(null), upsert: jest.fn(), create: userRoleCreate },
    } as unknown as TenantTx;
    const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const workflow = {
      createRequest: jest.fn().mockResolvedValue({ id: "wf-9" }),
      submit: jest.fn().mockResolvedValue({}),
    };
    const hooks = { onFinalized: jest.fn() };
    const service = new AdminService(db as never, audit as never, workflow as never, hooks as never);

    const res = await service.createUser(senior, { name: "Junior", email: "jr@t", role: "junior_admin" });
    expect(res).toMatchObject({ pendingApproval: true, requestId: "wf-9", role: "junior_admin" });
    expect(userRoleCreate).not.toHaveBeenCalled(); // no role until the checker approves
    expect(workflow.createRequest).toHaveBeenCalledWith(
      senior,
      expect.objectContaining({ type: "ADMIN_APPOINTMENT", payload: { userId: "new-u", roleName: "junior_admin" } }),
    );
    expect(typeof (res as { tempPassword: string }).tempPassword).toBe("string");
  });
});

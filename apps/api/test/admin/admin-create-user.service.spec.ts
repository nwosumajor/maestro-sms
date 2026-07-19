// =============================================================================
// AdminService.createUser — school-scoped profile creation guard tests
// =============================================================================
// A school_admin/principal may create profiles within THEIR OWN tenant (RLS scopes
// every write to p.schoolId) but must NEVER be able to mint a cross-tenant
// super_admin. Also proves the duplicate-email guard and that creation is audited.
// Tenant isolation itself is covered by the RLS e2e suite.

import { BadRequestException } from "@nestjs/common";
import { AdminService } from "../../src/admin/admin.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(over: { role?: Record<string, unknown> | null; existing?: Record<string, unknown> | null }) {
  const userCreate = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "new-user", ...args.data }),
  );
  const userRoleCreate = jest.fn().mockResolvedValue({ id: "ur1" });
  const tx = {
    role: { findFirst: jest.fn().mockResolvedValue(over.role === undefined ? { id: "r1" } : over.role) },
    user: {
      findFirst: jest.fn().mockResolvedValue(over.existing ?? null),
      create: userCreate,
    },
    userRole: { create: userRoleCreate },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const workflow = {
    createRequest: jest.fn().mockResolvedValue({ id: "wf-1" }),
    submit: jest.fn().mockResolvedValue({ id: "wf-1", state: "PENDING_REVIEW" }),
  };
  const hooks = { onFinalized: jest.fn() };
  return {
    service: new AdminService(db as never, audit as never, workflow as never, hooks as never),
    userCreate,
    userRoleCreate,
    audit,
    workflow,
  };
}

const p: Principal = { schoolId: "A", userId: "admin-1", roles: ["school_admin"], permissions: ["rbac.manage"] };

describe("AdminService.createUser", () => {
  it("refuses to create a super_admin (no cross-tenant escalation)", async () => {
    const { service, userCreate } = makeService({});
    await expect(
      service.createUser(p, { name: "Mallory", email: "m@t", role: "super_admin" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("creates a user in the caller's school, assigns the role, returns a temp password, and audits", async () => {
    const { service, userCreate, userRoleCreate, audit } = makeService({});
    const res = await service.createUser(p, { name: "Ada", email: "ada@t", role: "teacher" });
    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ schoolId: "A", email: "ada@t" }) }),
    );
    expect(userRoleCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ schoolId: "A", roleId: "r1" }) }),
    );
    expect(typeof res.tempPassword).toBe("string");
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.user.create", entity: "user" }),
      expect.anything(),
    );
  });

  it("rejects a duplicate email", async () => {
    const { service } = makeService({ existing: { id: "u-existing" } });
    await expect(
      service.createUser(p, { name: "Ada", email: "ada@t", role: "teacher" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

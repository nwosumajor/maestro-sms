// =============================================================================
// AdminService.removeRole — administrator-demotion guards
// =============================================================================
// Two admins (school_admin/principal) can manage each other's roles, but the
// school must never be able to lock itself out: (1) nobody may remove their OWN
// managing role (demotion is always a second person's deliberate act), and
// (2) the LAST managing role in the school cannot be removed by anyone but the
// operator. Ordinary roles keep the old behavior.

import { ConflictException } from "@nestjs/common";
import { AdminService } from "../../src/admin/admin.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(over: { remainingManaging?: number } = {}) {
  const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    role: { findFirst: jest.fn().mockResolvedValue({ id: "r1" }) },
    userRole: {
      count: jest.fn().mockResolvedValue(over.remainingManaging ?? 1),
      deleteMany,
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const workflow = { createRequest: jest.fn(), submit: jest.fn() };
  const hooks = { onFinalized: jest.fn() };
  return {
    service: new AdminService(db as never, audit as never, workflow as never, hooks as never),
    tx,
    deleteMany,
    audit,
  };
}

const admin = (userId: string): Principal => ({ schoolId: "A", userId, roles: ["school_admin"], permissions: ["rbac.manage"] });

describe("AdminService.removeRole", () => {
  it("refuses to remove your OWN school_admin role", async () => {
    const { service, deleteMany } = makeService();
    await expect(service.removeRole(admin("admin-1"), "admin-1", "school_admin")).rejects.toBeInstanceOf(ConflictException);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("refuses to remove your OWN principal role", async () => {
    const { service } = makeService();
    await expect(service.removeRole(admin("admin-1"), "admin-1", "principal")).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses to remove the school's LAST managing role (no zero-admin school)", async () => {
    const { service, deleteMany } = makeService({ remainingManaging: 0 });
    await expect(service.removeRole(admin("admin-1"), "admin-2", "school_admin")).rejects.toThrow(/last administrator/i);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("a DIFFERENT admin removes a managing role when another manager remains, and it audits", async () => {
    const { service, tx, deleteMany, audit } = makeService({ remainingManaging: 1 });
    const res = await service.removeRole(admin("admin-1"), "admin-2", "school_admin");
    expect(res.removed).toBe(true);
    // The survivor count excludes exactly the assignment being removed.
    expect((tx.userRole.count as jest.Mock).mock.calls[0][0].where).toMatchObject({
      NOT: { userId: "admin-2", roleId: "r1" },
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "admin-2", roleId: "r1" } });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "rbac.role.remove" }),
      expect.anything(),
    );
  });

  it("removing an ordinary (non-managing) role from yourself is still allowed", async () => {
    const { service, tx, deleteMany } = makeService();
    await service.removeRole(admin("admin-1"), "admin-1", "librarian");
    expect(deleteMany).toHaveBeenCalled();
    // No survivor count needed for non-managing roles.
    expect(tx.userRole.count as jest.Mock).not.toHaveBeenCalled();
  });
});

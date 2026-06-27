// =============================================================================
// SecurityService — elevation rules + audit viewer (in-memory fakes)
// =============================================================================

import { SecurityService } from "../../src/security/security.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(grant?: Record<string, unknown> | null) {
  const created = { id: "g-1", status: "PENDING", requestedById: "u-1", permission: "fee.manage" };
  const tx = {
    privilegeGrant: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...created, ...data })),
      findFirst: jest.fn().mockResolvedValue(grant === undefined ? null : grant),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...created, ...grant, ...data })),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "u-1", name: "Alice" }]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new SecurityService(db as never, audit as never);
  return { service, tx, audit };
}

const principal = (userId: string, perms: string[] = []): Principal => ({
  schoolId: "school-A",
  userId,
  roles: [],
  permissions: perms,
});

describe("SecurityService elevation", () => {
  it("a normal request is PENDING", async () => {
    const { service } = makeService();
    const g = await service.requestElevation(principal("u-1"), { permission: "fee.manage", reason: "month end" });
    expect(g.status).toBe("PENDING");
    expect(g.breakGlass).toBe(false);
  });

  it("break-glass is ACTIVE immediately and self-approved", async () => {
    const { service, audit } = makeService();
    const g = await service.requestElevation(principal("u-1"), { permission: "fee.manage", reason: "urgent", breakGlass: true });
    expect(g.status).toBe("ACTIVE");
    expect(g.approvedById).toBe("u-1");
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "security.elevation.breakglass" }),
      expect.anything(),
    );
  });

  it("a non-elevatable permission is REJECTED (no self-escalation to platform/cross-tenant)", async () => {
    const { service } = makeService();
    // Normal request and break-glass both refuse platform.operate / maker-checker perms.
    await expect(
      service.requestElevation(principal("u-1"), { permission: "platform.operate", reason: "x" }),
    ).rejects.toThrow(/cannot be granted via elevation/i);
    await expect(
      service.requestElevation(principal("u-1"), { permission: "fee.approve", reason: "x", breakGlass: true }),
    ).rejects.toThrow(/cannot be granted via elevation/i);
  });

  it("the requester cannot approve their own request (separation of duties)", async () => {
    const { service } = makeService({ id: "g-1", status: "PENDING", requestedById: "u-1", permission: "fee.manage" });
    await expect(service.approveElevation(principal("u-1"), "g-1")).rejects.toThrow(/cannot approve your own/i);
  });

  it("a different approver activates the grant", async () => {
    const { service, audit } = makeService({ id: "g-1", status: "PENDING", requestedById: "u-1", permission: "fee.manage" });
    const g = await service.approveElevation(principal("u-2"), "g-1");
    expect(g.status).toBe("ACTIVE");
    expect(g.approvedById).toBe("u-2");
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "security.elevation.approve" }),
      expect.anything(),
    );
  });

  it("approving a non-pending request is rejected", async () => {
    const { service } = makeService({ id: "g-1", status: "ACTIVE", requestedById: "u-1", permission: "fee.manage" });
    await expect(service.approveElevation(principal("u-2"), "g-1")).rejects.toThrow(/not pending/i);
  });

  it("audit viewer resolves actor names", async () => {
    const { service, tx } = makeService();
    (tx.auditLog as unknown as { findMany: jest.Mock }).findMany = jest.fn().mockResolvedValue([
      { id: "a-1", actorId: "u-1", action: "fee.invoice.create", entity: "invoice", createdAt: new Date() },
    ]);
    const rows = (await service.listAudit(principal("admin", ["security.audit.read"]), {})) as { actorName: string }[];
    expect(rows[0].actorName).toBe("Alice");
  });
});

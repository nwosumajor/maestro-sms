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
    user: {
      findMany: jest.fn().mockResolvedValue([{ id: "u-1", name: "Alice" }]),
      findFirst: jest.fn().mockResolvedValue({ id: "u-2", name: "Bola" }),
    },
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

  it("audit viewer resolves actor names and paginates (keyset)", async () => {
    const { service, tx } = makeService();
    (tx.auditLog as unknown as { findMany: jest.Mock }).findMany = jest.fn().mockResolvedValue([
      { id: "a-1", actorId: "u-1", action: "fee.invoice.create", entity: "invoice", entityId: "inv-1", createdAt: new Date() },
    ]);
    const page = await service.listAudit(principal("admin", ["security.audit.read"]), {});
    expect(page.entries[0].actorName).toBe("Alice");
    // One row returned, well under the default page size ⇒ no further page.
    expect(page.nextCursor).toBeNull();
  });
});

// =============================================================================
// HANDOVER — a senior lends a duty they already hold, without being asked
// =============================================================================
// The requested path is bottom-up and needs a DIFFERENT approver. This is top-down
// and needs a different RECIPIENT. The single check that makes it safe is that the
// granter must ALREADY HOLD the permission — without it, "delegation" becomes a way
// to mint authority, and the first test here is the one that would catch that.
// =============================================================================

describe("SecurityService.delegateElevation", () => {
  const senior = (perms: string[]) => principal("u-1", perms);

  it("REFUSES to hand over a permission the granter does not hold", async () => {
    // The load-bearing test. A school_admin must not be able to hand out authority
    // nobody gave them: a handover moves authority sideways, never manufactures it.
    const { service, tx } = makeService();
    await expect(
      service.delegateElevation(senior(["security.elevation.approve"]), {
        userId: "u-2",
        permission: "certificate.issue",
        reason: "cover while I travel",
      }),
    ).rejects.toThrow(/do not hold it yourself/i);
    expect(tx.privilegeGrant.create).not.toHaveBeenCalled();
  });

  it("hands over a permission the granter DOES hold, active immediately", async () => {
    const { service, tx } = makeService();
    const out = await service.delegateElevation(senior(["certificate.issue"]), {
      userId: "u-2",
      permission: "certificate.issue",
      reason: "cover while I travel",
      hours: 48,
    });
    expect(out).toMatchObject({ status: "ACTIVE", delegated: true, userId: "u-2" });
    // Recorded as a handover, not as a self-approved break-glass — they mean
    // different things to whoever reads this later.
    expect(tx.privilegeGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ delegated: true, breakGlass: false }) }),
    );
  });

  it("refuses the maker-checker authorities, whoever asks", async () => {
    // Lending the "checker" half of a maker-checker rule does not delegate a duty;
    // it removes the second pair of eyes. Even a granter who holds it cannot pass
    // it on — which is exactly the case the check above would otherwise allow.
    for (const permission of ["fee.approve", "hr.salary.approve", "rbac.manage", "security.elevation.approve"]) {
      const { service, tx } = makeService();
      await expect(
        service.delegateElevation(senior([permission]), { userId: "u-2", permission, reason: "cover" }),
      ).rejects.toThrow(/cannot be delegated/i);
      expect(tx.privilegeGrant.create).not.toHaveBeenCalled();
    }
  });

  it("refuses a handover to yourself", async () => {
    const { service } = makeService();
    await expect(
      service.delegateElevation(senior(["certificate.issue"]), {
        userId: "u-1",
        permission: "certificate.issue",
        reason: "cover",
      }),
    ).rejects.toThrow(/someone else/i);
  });

  it("is always bounded", async () => {
    const { service } = makeService();
    const base = { userId: "u-2", permission: "certificate.issue", reason: "cover" };
    await expect(service.delegateElevation(senior(["certificate.issue"]), { ...base, hours: 0 })).rejects.toThrow();
    await expect(
      service.delegateElevation(senior(["certificate.issue"]), { ...base, hours: 24 * 61 }),
    ).rejects.toThrow();
    await expect(
      service.delegateElevation(senior(["certificate.issue"]), { ...base, hours: 24 * 60 }),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("requires a reason", async () => {
    const { service } = makeService();
    await expect(
      service.delegateElevation(senior(["certificate.issue"]), { userId: "u-2", permission: "certificate.issue", reason: " " }),
    ).rejects.toThrow();
  });

  it("audits the handover with the recipient and the window", async () => {
    const { service, audit } = makeService();
    await service.delegateElevation(senior(["certificate.issue"]), {
      userId: "u-2",
      permission: "certificate.issue",
      reason: "cover while I travel",
      hours: 24,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "security.elevation.delegate",
        metadata: expect.objectContaining({ permission: "certificate.issue", toUserId: "u-2", hours: 24 }),
      }),
      expect.anything(),
    );
  });
});

// ===========================================================================
// Recertification: WHAT IS WORTH REVIEWING
// ===========================================================================
// The report listed every account in the school. On a 900-pupil school that
// was 977 assignments, 901 of them a pupil holding "student" — the role that
// grants the least — in a 128kb payload growing with the roll. The cost is not
// only speed: a reviewer who must scroll past nine hundred identical rows to
// reach fifteen staff accounts is a reviewer who signs it off unread.
describe("SecurityService recertification scope", () => {
  const mk = (userRoles: { user: { id: string; name: string; email: string }; role: { name: string } }[]) => {
    const tx = {
      role: { findMany: jest.fn().mockResolvedValue([]) },
      userRole: { findMany: jest.fn().mockResolvedValue(userRoles) },
      privilegeGrant: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as TenantTx;
    const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    return new SecurityService(db as never, { record: jest.fn() } as never);
  };
  const u = (id: string, role: string) => ({ user: { id, name: id, email: `${id}@s` }, role: { name: role } });

  it("lists staff and leaves out accounts that are only a pupil or guardian", async () => {
    const svc = mk([u("pupil-1", "student"), u("pupil-2", "student"), u("mum", "parent"), u("teach", "teacher")]);
    const r = await svc.recertification(principal("admin"));
    expect(r.assignments.map((a) => a.id)).toEqual(["teach"]);
    expect(r.baselineAccountsExcluded).toBe(3);
  });

  // The grant this report exists to surface: a pupil account that has ALSO
  // been given a staff role must never be filtered out by the pupil half.
  it("KEEPS a pupil who has also been given a staff role", async () => {
    const svc = mk([u("pupil-1", "student"), u("pupil-1", "teacher")]);
    const r = await svc.recertification(principal("admin"));
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0].roles.sort()).toEqual(["student", "teacher"]);
    expect(r.baselineAccountsExcluded).toBe(0);
  });

  it("reports zero excluded when every account is staff", async () => {
    const svc = mk([u("head", "principal")]);
    const r = await svc.recertification(principal("admin"));
    expect(r.assignments).toHaveLength(1);
    expect(r.baselineAccountsExcluded).toBe(0);
  });
});

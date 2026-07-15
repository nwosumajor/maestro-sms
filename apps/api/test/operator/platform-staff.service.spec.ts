// =============================================================================
// Platform staff provisioning — the constraints that stop it minting an owner
// =============================================================================
// This endpoint creates an identity with cross-tenant reach, so two properties do
// all the security work and must be pinned:
//   1. the role is HARD-PINNED to manager_admin — never caller-chosen, so it can
//      never produce a second super_admin,
//   2. status changes are scoped to platform-org manager_admins — so "revoke a
//      manager" can never become "disable the platform owner".
// Plus: staff are created MFA-mandatory and invite-only (no password ever leaves).

import { ConflictException, NotFoundException } from "@nestjs/common";
import { PLATFORM_STAFF_ROLE } from "@sms/types";
import { OperatorProvisioningService } from "../../src/operator/operator-provisioning.service";

const owner = { userId: "owner-1", schoolId: "platform", roles: ["super_admin"], permissions: ["platform.staff.manage"] };
const ORG = { id: "platform", name: "MAESTRO-SMS", slug: "sms-platform" };

function makeService(over: Partial<Record<string, unknown>> = {}) {
  const created: Record<string, unknown>[] = [];
  const client = {
    school: { findFirst: jest.fn().mockResolvedValue(ORG) },
    role: { findFirst: jest.fn().mockResolvedValue({ id: "role-mgr", name: PLATFORM_STAFF_ROLE }) },
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "new-1", status: "ACTIVE", createdAt: new Date(), ...data };
      }),
      update: jest.fn().mockResolvedValue({
        id: "mgr-1", email: "m@x.io", name: "M", status: "DISABLED", mfaEnabled: false,
        passwordChangedAt: null, createdAt: new Date(),
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    userRole: { create: jest.fn().mockResolvedValue({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
    ...over,
  };
  // (db, audit, privileged, notifications, email)
  const svc = new OperatorProvisioningService(
    { runAsTenant: async () => undefined } as never,
    { record: jest.fn() } as never,
    { client } as never,
    { enqueue: jest.fn() } as never,
    { send: jest.fn().mockResolvedValue(undefined) } as never,
  );
  // auditInOperatorTenant writes through the tenant db runner; stub it out.
  Object.assign(svc as unknown as Record<string, unknown>, {
    auditInOperatorTenant: jest.fn().mockResolvedValue(undefined),
  });
  return { svc, client, created };
}

describe("createPlatformStaff", () => {
  it("mints manager_admin — the role is pinned, never taken from the caller", async () => {
    const { svc, client } = makeService();
    await svc.createPlatformStaff(owner as never, { email: "m@x.io", name: "M" });
    // The role looked up is the pinned constant, not anything caller-supplied.
    expect(client.role.findFirst).toHaveBeenCalledWith({ where: { name: PLATFORM_STAFF_ROLE } });
    expect(PLATFORM_STAFF_ROLE).toBe("manager_admin"); // never super_admin
    expect(client.userRole.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ roleId: "role-mgr", schoolId: ORG.id }) }),
    );
  });

  it("creates staff in the PLATFORM org, MFA-mandatory, with first-login reset forced", async () => {
    const { svc, created } = makeService();
    await svc.createPlatformStaff(owner as never, { email: "m@x.io", name: "M" });
    expect(created[0]).toMatchObject({
      schoolId: ORG.id, // never a customer school
      mfaRequired: true, // they can onboard schools + read the platform audit trail
      passwordChangedAt: null, // forces set-password on first login
    });
  });

  it("never returns a password — the invite link is the only way in", async () => {
    const { svc } = makeService();
    const out = await svc.createPlatformStaff(owner as never, { email: "m@x.io", name: "M" });
    expect(Object.keys(out)).not.toContain("tempPassword");
    expect(JSON.stringify(out)).not.toMatch(/password/i);
    expect(out).toMatchObject({ activated: false });
  });

  it("409s a duplicate email rather than hijacking an existing account", async () => {
    const { svc, client } = makeService();
    client.user.findFirst.mockResolvedValueOnce({ id: "existing" });
    await expect(svc.createPlatformStaff(owner as never, { email: "m@x.io", name: "M" })).rejects.toThrow(
      ConflictException,
    );
  });
});

describe("setPlatformStaffStatus", () => {
  it("revokes a platform manager", async () => {
    const { svc, client } = makeService();
    client.user.findFirst.mockResolvedValueOnce({ id: "mgr-1" }); // the scoped lookup finds them
    const out = await svc.setPlatformStaffStatus(owner as never, "mgr-1", "DISABLED");
    expect(out.status).toBe("DISABLED");
  });

  it("404s for a userId that is not a platform-org manager_admin — so it can NEVER disable the owner", async () => {
    const { svc, client } = makeService();
    // The scoping query (schoolId=platform AND role=manager_admin) finds nothing.
    client.user.findFirst.mockResolvedValueOnce(null);
    await expect(svc.setPlatformStaffStatus(owner as never, "owner-1", "DISABLED")).rejects.toThrow(NotFoundException);
    expect(client.user.update).not.toHaveBeenCalled();
  });

  it("scopes the lookup to platform-org manager_admins", async () => {
    const { svc, client } = makeService();
    client.user.findFirst.mockResolvedValueOnce({ id: "mgr-1" });
    await svc.setPlatformStaffStatus(owner as never, "mgr-1", "ACTIVE");
    expect(client.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "mgr-1",
          schoolId: ORG.id,
          roles: { some: { role: { name: PLATFORM_STAFF_ROLE } } },
        }),
      }),
    );
  });
});

// =============================================================================
// AdminService.createUser — school-scoped profile creation guard tests
// =============================================================================
// A school_admin/principal may create profiles within THEIR OWN tenant (RLS scopes
// every write to p.schoolId) but must NEVER be able to mint a cross-tenant
// super_admin. Also proves the duplicate-email guard and that creation is audited.
// Tenant isolation itself is covered by the RLS e2e suite.

import { NotFoundException, BadRequestException } from "@nestjs/common";
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
    // A generated sign-in identifier resolves the school's slug for its domain.
    school: { findFirst: jest.fn().mockResolvedValue({ slug: "demo" }) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const workflow = {
    createRequest: jest.fn().mockResolvedValue({ id: "wf-1" }),
    submit: jest.fn().mockResolvedValue({ id: "wf-1", state: "PENDING_REVIEW" }),
  };
  const hooks = { onFinalized: jest.fn() };
  return {
    service: new AdminService(db as never, audit as never, workflow as never, { client: null } as never, hooks as never),
    userCreate,
    userRoleCreate,
    audit,
    workflow,
  };
}

const p: Principal = { schoolId: "A", userId: "admin-1", roles: ["school_admin"], permissions: ["rbac.manage"] };

describe("AdminService.createUser", () => {
  it("refuses to create a platform-tier user (no cross-tenant escalation)", async () => {
    const { service, userCreate } = makeService({});
    // 404, not 400: a school-level admin must not learn that a platform role
    // even exists. Covers manager_admin too — see platform-tier-roles.spec.ts.
    await expect(
      service.createUser(p, { name: "Mallory", email: "m@t", role: "super_admin" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.createUser(p, { name: "Mallory", email: "m@t", role: "manager_admin" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("creates a user in the caller's school, assigns the role, returns a temp password, and audits", async () => {
    const { service, userCreate, userRoleCreate, audit } = makeService({});
    const res = await service.createUser(p, { name: "Ada", email: "ada@t", contactEmail: "ada@real.test", role: "teacher" });
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
      service.createUser(p, { name: "Ada", email: "ada@t", contactEmail: "ada@real.test", role: "teacher" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// -----------------------------------------------------------------------------
// Contact email is REQUIRED for anyone who needs to receive mail
// -----------------------------------------------------------------------------
// Sign-in identifiers are generated (firstname.lastname@<slug>.com) and are NOT
// mailboxes. Without a contact address a staff member or parent can never get an
// invite or a password reset, and the account is unrecoverable the first time
// they forget their password. Students are exempt: guardians are notified.
describe("AdminService.createUser — contact email requirement", () => {
  it("REFUSES a staff account with no contact email", async () => {
    const { service } = makeService({});
    await expect(service.createUser(p, { name: "Ngozi Bello", role: "teacher" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("REFUSES a parent with no contact email", async () => {
    const { service } = makeService({});
    await expect(service.createUser(p, { name: "Grace Eze", role: "parent" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("ALLOWS a student without one — most pupils have no address of their own", async () => {
    const { service } = makeService({});
    const res = await service.createUser(p, { name: "Tunde Okoro", role: "student" });
    // And the identifier it issued is the GENERATED one, not undefined.
    expect(res.email).toBe("tunde.okoro@demo.com");
  });

  it("stamps loginEmailGenerated so delivery knows it is not a mailbox", async () => {
    const { service, userCreate } = makeService({});
    await service.createUser(p, { name: "Tunde Okoro", role: "student" });
    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ loginEmailGenerated: true }) }),
    );
  });
});

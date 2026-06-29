// =============================================================================
// OperatorUserService — super_admin user-governance scoping unit tests
// =============================================================================
// Proves the application-level guards the privileged client cannot get from RLS
// (it bypasses RLS by design): a super_admin target is invisible (404 not 403, no
// cross-operator tamper), the directory maps to the DTO, mutations audit in the
// operator's own tenant, and the role mandate refuses the super_admin role.
// Cross-tenant isolation of the underlying tables is covered by the RLS e2e suite.

import { NotFoundException, ConflictException } from "@nestjs/common";
import { OperatorUserService } from "../../src/operator/operator-user.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

type Row = Record<string, unknown>;

function makeService(over: {
  users?: Row[];
  findFirst?: (args: { where: Row }) => Row | null;
  school?: Row | null;
  role?: Row | null;
}) {
  const userUpdate = jest.fn((args: { where: Row; data: Row }) =>
    Promise.resolve({ id: "u1", ...args.data }),
  );
  const updateMany = jest.fn().mockResolvedValue({ count: 3 });
  const client = {
    user: {
      findMany: jest.fn().mockResolvedValue(over.users ?? []),
      findFirst: jest.fn((args: { where: Row }) =>
        Promise.resolve(over.findFirst ? over.findFirst(args) : null),
      ),
      update: userUpdate,
      updateMany,
    },
    school: { findFirst: jest.fn().mockResolvedValue(over.school ?? { id: "A" }) },
    role: { findFirst: jest.fn().mockResolvedValue(over.role ?? { id: "r1" }) },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn({} as TenantTx) };
  const service = new OperatorUserService(db as never, audit as never);
  // Inject the fake privileged client (normally built in onModuleInit from a URL).
  (service as unknown as { _client: unknown })._client = client;
  return { service, client, userUpdate, updateMany, audit };
}

const op: Principal = { schoolId: "OP", userId: "super-1", roles: ["super_admin"], permissions: ["platform.operate"] };
const normalUser = (over: Row = {}): Row => ({
  id: "u1",
  roles: [{ role: { name: "teacher" } }],
  ...over,
});

describe("OperatorUserService", () => {
  it("listUsers maps rows to the DTO shape (roles flattened)", async () => {
    const { service } = makeService({
      users: [
        {
          id: "u1",
          name: "Ada",
          email: "ada@t",
          status: "ACTIVE",
          mfaEnabled: false,
          mfaRequired: true,
          lockedUntil: null,
          roles: [{ role: { name: "teacher" } }, { role: { name: "hr_clerk" } }],
        },
      ],
    });
    const res = await service.listUsers("A");
    expect(res[0]).toMatchObject({ id: "u1", roles: ["teacher", "hr_clerk"], mfaRequired: true });
  });

  it("hides a super_admin target (404, not 403) on any mutation", async () => {
    const { service, userUpdate } = makeService({
      findFirst: () => normalUser({ roles: [{ role: { name: "super_admin" } }] }),
    });
    await expect(service.setStatus(op, "A", "u1", "DISABLED")).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.resetMfa(op, "A", "u1")).rejects.toBeInstanceOf(NotFoundException);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("setStatus updates the account and audits in the operator tenant", async () => {
    const { service, userUpdate, audit } = makeService({ findFirst: () => normalUser() });
    await service.setStatus(op, "A", "u1", "DISABLED");
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u1" }, data: { status: "DISABLED" } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "operator.user.status", entity: "user", schoolId: "OP" }),
      expect.anything(),
    );
  });

  it("resetPassword returns a one-time temp password and clears the lockout", async () => {
    const { service, userUpdate } = makeService({ findFirst: () => normalUser() });
    const res = await service.resetPassword(op, "A", "u1");
    expect(typeof res.tempPassword).toBe("string");
    expect(res.tempPassword.length).toBeGreaterThan(6);
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failedLoginCount: 0, lockedUntil: null }) }),
    );
  });

  it("setRoleMfaRequired bulk-flags holders but refuses the super_admin role", async () => {
    const { service, updateMany } = makeService({});
    const res = await service.setRoleMfaRequired(op, "A", "teacher", true);
    expect(res.affected).toBe(3);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { mfaRequired: true } }),
    );
    await expect(service.setRoleMfaRequired(op, "A", "super_admin", true)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

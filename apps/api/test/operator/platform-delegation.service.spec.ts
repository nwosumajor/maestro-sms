// =============================================================================
// PlatformDelegationService — the owner lends a duty, and takes it back
// =============================================================================
// The safety of this feature rests on ONE asymmetry: the grantor is the platform
// owner, who already holds everything they can give away, so a delegation is a loan
// rather than an escalation. Every test here checks a guard rail that keeps that
// asymmetry true — because if any one of them fails, the feature becomes a way to
// hand out owner powers quietly.
//
// The most important is the first: the non-delegable set. Impersonation, pricing,
// credentials and student PII must be unlendable at ANY duration, because lending
// one of them for a week is indistinguishable from giving it away.
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DELEGABLE_PLATFORM_PERMISSIONS, MAX_DELEGATION_DAYS, OPERATOR_PERMISSIONS } from "@sms/types";
import { PlatformDelegationService } from "../../src/operator/platform-delegation.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const OWNER = "11111111-1111-1111-1111-111111111111";
const MANAGER = "22222222-2222-2222-2222-222222222222";
const owner: Principal = { schoolId: "PLAT", userId: OWNER, roles: ["super_admin"], permissions: [] };

const LENDABLE = OPERATOR_PERMISSIONS.PLATFORM_ONBOARDING_REVIEW;

function makeService(over: Record<string, unknown> = {}) {
  const tx = {
    user: {
      findFirst: jest.fn().mockResolvedValue({
        id: MANAGER,
        name: "Ada Manager",
        email: "ada@sms.platform",
        roles: [{ role: { name: "manager_admin" } }],
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    platformDelegation: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "d-1",
        ...data,
        createdAt: new Date(),
        revokedAt: null,
        revokedById: null,
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "d-1",
        userId: MANAGER,
        permission: LENDABLE,
        reason: "cover",
        grantedById: OWNER,
        createdAt: new Date(),
        revokedAt: null,
        revokedById: null,
        ...data,
      })),
    },
    ...over,
  };
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
  };
  const audit = { record: jest.fn() };
  return { svc: new PlatformDelegationService(db as never, audit as never), tx, audit };
}

const grant = (over: Record<string, unknown> = {}) => ({
  userId: MANAGER,
  permission: LENDABLE,
  reason: "Covering onboarding while I travel",
  ...over,
});

describe("PlatformDelegationService.grant", () => {
  it("REFUSES every permission outside the delegable set", async () => {
    // The load-bearing test. These four are the owner's alone at any duration:
    // lending impersonation for a week is giving away impersonation.
    const forbidden = [
      OPERATOR_PERMISSIONS.PLATFORM_OPERATE,
      OPERATOR_PERMISSIONS.PLATFORM_IMPERSONATE,
      OPERATOR_PERMISSIONS.PLATFORM_PRICING_MANAGE,
      OPERATOR_PERMISSIONS.PLATFORM_STAFF_MANAGE,
      OPERATOR_PERMISSIONS.PLATFORM_STUDENT_READ,
    ];
    for (const permission of forbidden) {
      const { svc, tx } = makeService();
      await expect(svc.grant(owner, grant({ permission }))).rejects.toBeInstanceOf(BadRequestException);
      // And nothing is written on the way out.
      expect(tx.platformDelegation.create).not.toHaveBeenCalled();
    }
  });

  it("accepts every permission INSIDE the delegable set", async () => {
    // The mirror of the above: the allow-list is not accidentally empty. A denylist
    // that refuses everything would pass the test above and be useless.
    for (const permission of DELEGABLE_PLATFORM_PERMISSIONS) {
      const { svc } = makeService();
      await expect(svc.grant(owner, grant({ permission }))).resolves.toMatchObject({ permission, active: true });
    }
  });

  it("refuses a self-grant", async () => {
    // Auditing to the same person on both sides proves nothing, and the owner
    // already holds all of these — the only reason to do it is to muddy the trail.
    const { svc } = makeService();
    await expect(svc.grant(owner, grant({ userId: OWNER }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses anyone who is not a platform manager", async () => {
    const { svc } = makeService({
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: MANAGER,
          name: "Random",
          email: "r@x",
          roles: [{ role: { name: "teacher" } }],
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    });
    await expect(svc.grant(owner, grant())).rejects.toBeInstanceOf(BadRequestException);
  });

  it("404s an unknown grantee rather than disclosing which ids exist", async () => {
    const { svc } = makeService({
      user: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    });
    await expect(svc.grant(owner, grant())).rejects.toBeInstanceOf(NotFoundException);
  });

  it("is always bounded — no open-ended loan, in either direction", async () => {
    // An unbounded delegation is a role change that nobody remembered to review.
    const { svc } = makeService();
    await expect(svc.grant(owner, grant({ days: 0 }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.grant(owner, grant({ days: MAX_DELEGATION_DAYS + 1 }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.grant(owner, grant({ days: MAX_DELEGATION_DAYS }))).resolves.toMatchObject({ active: true });
  });

  it("requires a reason", async () => {
    // Unreviewable six months later is exactly when somebody asks why this person
    // had this access.
    const { svc } = makeService();
    await expect(svc.grant(owner, grant({ reason: "  " }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it("EXTENDS a live loan rather than stacking a second row", async () => {
    // Two live grants of the same duty make "when does this end" ambiguous, and
    // revoking one would look like it worked.
    const { svc, tx } = makeService();
    tx.platformDelegation.findFirst.mockResolvedValue({ id: "existing" });
    await svc.grant(owner, grant({ days: 30 }));
    expect(tx.platformDelegation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "existing" } }),
    );
    expect(tx.platformDelegation.create).not.toHaveBeenCalled();
  });

  it("audits the grant with the permission, window and recipient", async () => {
    const { svc, audit } = makeService();
    await svc.grant(owner, grant({ days: 5 }));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: OWNER,
        action: "platform.delegation.grant",
        entityId: MANAGER,
        metadata: expect.objectContaining({ permission: LENDABLE, days: 5, to: "ada@sms.platform" }),
      }),
      expect.anything(),
    );
  });
});

describe("PlatformDelegationService.revoke", () => {
  it("marks the loan returned without deleting the record", async () => {
    // The row is the answer to "who had access on the day that happened".
    const { svc, tx, audit } = makeService();
    tx.platformDelegation.findFirst.mockResolvedValue({
      id: "d-1",
      userId: MANAGER,
      permission: LENDABLE,
      revokedAt: null,
    });
    await expect(svc.revoke(owner, "d-1")).resolves.toEqual({ revoked: true });
    expect(tx.platformDelegation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ revokedById: OWNER }) }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform.delegation.revoke" }),
      expect.anything(),
    );
  });

  it("is idempotent on an already-returned loan", async () => {
    const { svc, tx } = makeService();
    tx.platformDelegation.findFirst.mockResolvedValue({ id: "d-1", userId: MANAGER, permission: LENDABLE, revokedAt: new Date() });
    await expect(svc.revoke(owner, "d-1")).resolves.toEqual({ revoked: true });
    expect(tx.platformDelegation.update).not.toHaveBeenCalled();
  });

  it("404s an unknown id", async () => {
    const { svc } = makeService();
    await expect(svc.revoke(owner, "nope")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("PlatformDelegationService.hasDelegation (the guard's question)", () => {
  it("refuses a non-delegable permission even if a row somehow exists", async () => {
    // Defence in depth, mirroring isElevatable: a row written before the lendable
    // set was tightened — or inserted by any other route — must not be honoured.
    const { svc, tx } = makeService();
    tx.platformDelegation.findFirst.mockResolvedValue({ id: "tampered" });
    await expect(
      svc.hasDelegation(tx as unknown as TenantTx, MANAGER, OPERATOR_PERMISSIONS.PLATFORM_IMPERSONATE),
    ).resolves.toBe(false);
    // It does not even ask the database.
    expect(tx.platformDelegation.findFirst).not.toHaveBeenCalled();
  });

  it("only counts loans that are neither revoked nor expired", async () => {
    const { svc, tx } = makeService();
    await svc.hasDelegation(tx as unknown as TenantTx, MANAGER, LENDABLE);
    expect(tx.platformDelegation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revokedAt: null, expiresAt: expect.objectContaining({ gt: expect.any(Date) }) }),
      }),
    );
  });
});

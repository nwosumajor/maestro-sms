// =============================================================================
// The platform permission split — the invariants that keep it real
// =============================================================================
// Platform duties are delegable to staff (manager_admin); OWNERSHIP is not. This
// suite pins the properties that make that true, so the split can't silently rot:
//   1. every platform.* permission is NON-ELEVATABLE (else staff self-escalate),
//   2. the delegable set contains nothing that is — or becomes — absolute control,
//   3. the guard actually 403s a manager_admin on an owner-only route.
// A future permission added to OPERATOR_PERMISSIONS is covered automatically by
// (1); (2) names the dangerous ones explicitly so adding one to the delegable
// list fails loudly rather than quietly handing over the platform.

import { ForbiddenException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import {
  ALL_PLATFORM_PERMISSIONS,
  DELEGABLE_PLATFORM_PERMISSIONS,
  LENDABLE_PLATFORM_PERMISSIONS,
  OPERATOR_PERMISSIONS,
  PLATFORM_STAFF_BASELINE_PERMISSIONS,
  ROLE_PERMISSIONS,
  isDelegatablePlatformPermission,
  isElevatable,
} from "@sms/types";

/** Powers that ARE, or BECOME, total control — never delegable, whatever else changes. */
const OWNER_ONLY = [
  OPERATOR_PERMISSIONS.PLATFORM_OPERATE, // owner identity (cross-school directory)
  OPERATOR_PERMISSIONS.PLATFORM_IMPERSONATE, // becomes any user
  OPERATOR_PERMISSIONS.PLATFORM_USER_CREDENTIALS, // temp password = a login for that account
  OPERATOR_PERMISSIONS.PLATFORM_TENANTS_STATUS, // takes a paying school offline
  OPERATOR_PERMISSIONS.PLATFORM_SUBSCRIPTION_MANAGE, // revenue
  OPERATOR_PERMISSIONS.PLATFORM_PRICING_MANAGE, // revenue
  OPERATOR_PERMISSIONS.PLATFORM_STUDENT_READ, // minors' PII, cross-tenant
  OPERATOR_PERMISSIONS.PLATFORM_STAFF_MANAGE, // staff creating staff = a manager mints a manager
];

describe("platform permission split", () => {
  it("EVERY platform permission is non-elevatable (staff can never JIT-escalate into one)", () => {
    for (const perm of ALL_PLATFORM_PERMISSIONS) {
      expect({ perm, elevatable: isElevatable(perm) }).toEqual({ perm, elevatable: false });
    }
  });

  it("the delegable set contains NO owner-only power", () => {
    for (const owner of OWNER_ONLY) {
      expect(DELEGABLE_PLATFORM_PERMISSIONS).not.toContain(owner);
    }
  });

  it("delegable = oversight + operations only", () => {
    expect([...DELEGABLE_PLATFORM_PERMISSIONS].sort()).toEqual(
      [
        "platform.audit.read",
        "platform.onboarding.review",
        "platform.tenants.read",
        "platform.tenants.write",
        "platform.user.read",
        "platform.user.unlock",
        "platform.grace.manage",
        "platform.feedback.review",
      ].sort(),
    );
  });

  it("every platform permission is either delegable or owner-only — none unclassified", () => {
    const classified = new Set([...DELEGABLE_PLATFORM_PERMISSIONS, ...OWNER_ONLY]);
    expect(ALL_PLATFORM_PERMISSIONS.filter((p) => !classified.has(p))).toEqual([]);
  });

  // --- the third tier: LENDABLE but never STANDING ---------------------------
  // "A role carries this permanently" and "the owner lent it for eleven days, with
  // a reason, revocable in one click, and logged at every use" are different risks.
  // Conflating them is what made time-bound delegation pointless: the manager
  // already held everything it could grant.
  it("the higher tier is lendable but NEVER a standing role permission", () => {
    for (const perm of [OPERATOR_PERMISSIONS.PLATFORM_TENANTS_STATUS, OPERATOR_PERMISSIONS.PLATFORM_SUBSCRIPTION_MANAGE]) {
      expect(LENDABLE_PLATFORM_PERMISSIONS).toContain(perm); // may be lent, briefly
      expect(DELEGABLE_PLATFORM_PERMISSIONS).not.toContain(perm); // never by role
      expect(ROLE_PERMISSIONS.manager_admin).not.toContain(perm); // and not in the seed
    }
  });

  it("total control is lendable at NO duration", () => {
    // The four that stay with the owner whatever the mechanism: lending one of
    // these for a week is indistinguishable from giving it away.
    for (const perm of [
      OPERATOR_PERMISSIONS.PLATFORM_OPERATE,
      OPERATOR_PERMISSIONS.PLATFORM_IMPERSONATE,
      OPERATOR_PERMISSIONS.PLATFORM_USER_CREDENTIALS,
      OPERATOR_PERMISSIONS.PLATFORM_PRICING_MANAGE,
      OPERATOR_PERMISSIONS.PLATFORM_STUDENT_READ,
      OPERATOR_PERMISSIONS.PLATFORM_STAFF_MANAGE,
    ]) {
      expect(LENDABLE_PLATFORM_PERMISSIONS).not.toContain(perm);
      expect(isDelegatablePlatformPermission(perm)).toBe(false);
    }
  });

  it("a manager's STANDING role is the bare floor — everything else is lent", () => {
    // The regression that made this feature a no-op: manager_admin used to carry
    // all eight delegable duties permanently, so there was nothing left to lend.
    expect([...ROLE_PERMISSIONS.manager_admin].sort()).toEqual(["notification.read", "platform.tenants.read"]);
    // And the floor must be a strict subset of what can be lent, or the role would
    // grant something delegation could never take back.
    for (const perm of PLATFORM_STAFF_BASELINE_PERMISSIONS) {
      expect(LENDABLE_PLATFORM_PERMISSIONS).toContain(perm);
    }
  });
});

// --- the guard actually enforces it -----------------------------------------
const managerPrincipal = {
  userId: "mgr-1",
  schoolId: "platform",
  roles: ["manager_admin"],
  // The manager's REAL standing permissions now — the bare floor. Duties beyond
  // it arrive only as a live delegation, which this fixture deliberately has none of.
  permissions: [...ROLE_PERMISSIONS.manager_admin],
};
jest.mock("../../src/auth/jwt", () => ({ verifyToken: () => managerPrincipal }));

import { PermissionGuard } from "../../src/auth/permission.guard";
import { PUBLIC_KEY } from "../../src/auth/public.decorator";
import { MODULE_KEY } from "../../src/auth/require-module.decorator";
import { PERMISSION_KEY } from "../../src/auth/require-permission.decorator";
import { STEPUP_KEY } from "../../src/auth/require-stepup.decorator";

function ctx(): ExecutionContext {
  const req = { headers: { authorization: "Bearer t" } };
  const res = { setHeader: jest.fn() };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => null,
    getClass: () => null,
  } as unknown as ExecutionContext;
}
function reflector(required: string): Reflector {
  const map: Record<string, unknown> = {
    [PUBLIC_KEY]: undefined,
    [MODULE_KEY]: undefined,
    [PERMISSION_KEY]: required,
    [STEPUP_KEY]: false,
  };
  return { getAllAndOverride: (k: string) => map[k] } as unknown as Reflector;
}
const allowRate = { consume: jest.fn().mockResolvedValue({ allowed: true, limit: 1, remaining: 1, resetMs: 1 }) };
// No JIT grant exists — and even if one did, these permissions are non-elevatable.
const noGrantDb = { runAsTenant: async () => false, runAsTenantReadOnly: async () => false };

describe("PermissionGuard — manager_admin boundary", () => {
  it.each(OWNER_ONLY)("403s a manager_admin on owner-only %s", async (perm) => {
    const guard = new PermissionGuard(reflector(perm), noGrantDb as never, {} as never, {} as never, { forRoles: jest.fn().mockResolvedValue([]) } as never, allowRate as never);
    await expect(guard.canActivate(ctx())).rejects.toThrow(ForbiddenException);
  });

  it("allows a manager_admin on the standing floor without any delegation", async () => {
    const guard = new PermissionGuard(reflector(OPERATOR_PERMISSIONS.PLATFORM_TENANTS_READ), noGrantDb as never, {} as never, {} as never, { forRoles: jest.fn().mockResolvedValue([]) } as never, allowRate as never);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  // The delegation contract, at the guard. A manager holds NONE of these by role
  // any more, so each is 403 until the owner lends it — and allowed the moment they
  // do, on the SAME token, because the guard reads the delegation table rather than
  // the JWT. That is also why a hand-back takes effect immediately.
  const lendableBeyondFloor = LENDABLE_PLATFORM_PERMISSIONS.filter(
    (p) => !ROLE_PERMISSIONS.manager_admin.includes(p),
  );

  it.each(lendableBeyondFloor)("403s a manager_admin on %s with NO delegation", async (perm) => {
    const guard = new PermissionGuard(reflector(perm), noGrantDb as never, {} as never, {} as never, { forRoles: jest.fn().mockResolvedValue([]) } as never, allowRate as never);
    await expect(guard.canActivate(ctx())).rejects.toThrow(ForbiddenException);
  });

  it.each(lendableBeyondFloor)("ALLOWS a manager_admin on %s once the owner has lent it", async (perm) => {
    // A tx whose delegation lookup finds a live loan, and whose audit record
    // succeeds — the guard audits every USE, not merely the grant.
    const lentDb = {
      runAsTenant: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          platformDelegation: { findFirst: async () => ({ id: "live" }) },
          privilegeGrant: { findFirst: async () => null },
          auditLog: { create: async () => ({}) },
        }),
      runAsTenantReadOnly: async () => false,
    };
    const guard = new PermissionGuard(
      reflector(perm),
      lentDb as never,
      { record: jest.fn() } as never,
      {} as never,
      { forRoles: jest.fn().mockResolvedValue([]) } as never,
      allowRate as never,
    );
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it("a lent loan can NEVER carry an owner-only power, whatever the row says", async () => {
    // Defence in depth: even a tampered or legacy row claiming platform.impersonate
    // is refused, because the guard re-checks the lendable set before it looks.
    const lentDb = {
      runAsTenant: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ platformDelegation: { findFirst: async () => ({ id: "tampered" }) }, privilegeGrant: { findFirst: async () => null } }),
      runAsTenantReadOnly: async () => false,
    };
    const guard = new PermissionGuard(
      reflector(OPERATOR_PERMISSIONS.PLATFORM_IMPERSONATE),
      lentDb as never,
      { record: jest.fn() } as never,
      {} as never,
      { forRoles: jest.fn().mockResolvedValue([]) } as never,
      allowRate as never,
    );
    await expect(guard.canActivate(ctx())).rejects.toThrow(ForbiddenException);
  });
});

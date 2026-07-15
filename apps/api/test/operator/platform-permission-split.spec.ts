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
  OPERATOR_PERMISSIONS,
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
      ].sort(),
    );
  });

  it("every platform permission is either delegable or owner-only — none unclassified", () => {
    const classified = new Set([...DELEGABLE_PLATFORM_PERMISSIONS, ...OWNER_ONLY]);
    expect(ALL_PLATFORM_PERMISSIONS.filter((p) => !classified.has(p))).toEqual([]);
  });
});

// --- the guard actually enforces it -----------------------------------------
const managerPrincipal = {
  userId: "mgr-1",
  schoolId: "platform",
  roles: ["manager_admin"],
  permissions: [...DELEGABLE_PLATFORM_PERMISSIONS],
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
    const guard = new PermissionGuard(reflector(perm), noGrantDb as never, {} as never, {} as never, allowRate as never);
    await expect(guard.canActivate(ctx())).rejects.toThrow(ForbiddenException);
  });

  it.each([...DELEGABLE_PLATFORM_PERMISSIONS])("allows a manager_admin on delegable %s", async (perm) => {
    const guard = new PermissionGuard(reflector(perm), noGrantDb as never, {} as never, {} as never, allowRate as never);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });
});

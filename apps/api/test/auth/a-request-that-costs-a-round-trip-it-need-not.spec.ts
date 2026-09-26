// =============================================================================
// A request that costs a round trip it need not — the per-request DB budget
// =============================================================================
// The API lost two-thirds of its capacity (770 -> 216 req/s) without any single
// change being slow. Two of the causes were per-request DATABASE work in layers
// every request crosses: the PermissionGuard opened a whole transaction to read
// elevation grants that almost nobody holds, and the tenant runner set its two
// RLS settings in two statements rather than one. Neither shows in a unit test
// of any feature, and a load test on a shared CI runner is too noisy to fail a
// pull request on. A COUNT is not noisy: this pins how many database calls the
// shared layers make, deterministically, so the next one is a red test and not
// a slow month.
//
// The guard is built from its REAL caching collaborators (entitlements, school
// status, role map, grant absence) over a counting database, so a cache that
// stops caching is caught here, not only a guard that stops asking.
// =============================================================================

import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";

jest.mock("../../src/auth/jwt", () => ({
  verifyToken: () => ({ userId: "u", schoolId: "s", roles: ["teacher"], permissions: [] as string[] }),
}));

const executed: string[] = [];
const transactions = { n: 0 };
jest.mock("@sms/db", () => {
  const actual = jest.requireActual("@sms/db");
  const fakeTx = {
    $executeRaw: async (q: TemplateStringsArray) => {
      executed.push(q.join("?"));
      return 1;
    },
    $executeRawUnsafe: async (q: string) => {
      executed.push(q);
      return 0;
    },
    $queryRawUnsafe: async () => [],
  };
  const client = {
    $transaction: async (fn: (tx: unknown) => unknown) => {
      transactions.n++;
      return fn(fakeTx);
    },
    $queryRawUnsafe: async () => [],
    role: { findMany: jest.fn(async () => [{ name: "teacher", permissions: [{ permission: { key: "student.read" } }] }]) },
  };
  return { ...actual, prisma: client, readPrisma: client };
});

import { prisma } from "@sms/db";
import { PermissionGuard } from "../../src/auth/permission.guard";
import { PUBLIC_KEY } from "../../src/auth/public.decorator";
import { MODULE_KEY } from "../../src/auth/require-module.decorator";
import { PERMISSION_KEY } from "../../src/auth/require-permission.decorator";
import { STEPUP_KEY } from "../../src/auth/require-stepup.decorator";
import { GrantAbsenceCache } from "../../src/foundation/grant-absence-cache.service";
import { ModuleEntitlementService } from "../../src/foundation/module-entitlement.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { RolePermissionsService } from "../../src/foundation/role-permissions.service";
import { SchoolStatusService } from "../../src/foundation/school-status.service";

const ctx = (): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: "Bearer t" } }),
      getResponse: () => ({ setHeader: jest.fn() }),
    }),
    getHandler: () => null,
    getClass: () => null,
  }) as unknown as ExecutionContext;

/** A module-gated, permission-gated route: every cache the guard has is on the path. */
const reflector = {
  getAllAndOverride: (key: string) =>
    ({ [PUBLIC_KEY]: undefined, [MODULE_KEY]: "fees", [PERMISSION_KEY]: "student.read", [STEPUP_KEY]: false })[key],
} as unknown as Reflector;

describe("per-request database budget — the layers every request crosses", () => {
  it("the guard makes ZERO database calls per warm request for a user holding no grant", async () => {
    const calls: string[] = [];
    const db = {
      runAsTenant: jest.fn(async (_c: unknown, fn: (tx: unknown) => unknown) =>
        fn({
          schoolSubscription: {
            findFirst: async () => {
              calls.push("schoolSubscription");
              return { plan: "ENTERPRISE", overrides: {}, status: "ACTIVE", billingCycle: "TERM", currentPeriodEnd: null };
            },
          },
          school: {
            findFirst: async () => {
              calls.push("school");
              return { status: "ACTIVE" };
            },
          },
          privilegeGrant: {
            findMany: async () => {
              calls.push("privilegeGrant");
              return [];
            },
          },
        }),
      ),
    };
    const pubsub = { subscribe: jest.fn(), publish: jest.fn() };
    const guard = new PermissionGuard(
      reflector,
      db as never,
      { record: jest.fn() } as never,
      new ModuleEntitlementService(db as never, pubsub as never),
      new RolePermissionsService(),
      { consume: jest.fn().mockResolvedValue({ allowed: true, limit: 1, remaining: 1, resetMs: 1 }) } as never,
      new SchoolStatusService(db as never, pubsub as never),
      new GrantAbsenceCache(),
    );

    await expect(guard.canActivate(ctx())).resolves.toBe(true); // cold: fills every cache
    const coldRoleLoads = (prisma.role.findMany as jest.Mock).mock.calls.length;
    // The cold request must have REACHED every read, or "zero when warm" below
    // would be true of a fake nobody calls.
    expect([...calls].sort()).toEqual(["privilegeGrant", "school", "schoolSubscription"]);
    expect(coldRoleLoads).toBe(1);
    calls.length = 0;
    db.runAsTenant.mockClear();

    for (let i = 0; i < 50; i++) await expect(guard.canActivate(ctx())).resolves.toBe(true);

    // BUDGET: 0. Every one of these is a per-tenant or per-user fact that changes
    // rarely and is invalidated when it does. A new per-request read belongs in
    // a cache, or it belongs in this test with a reason.
    expect(calls).toEqual([]);
    expect(db.runAsTenant).not.toHaveBeenCalled();
    expect((prisma.role.findMany as jest.Mock).mock.calls.length).toBe(coldRoleLoads);
  });

  it("the tenant runner sets RLS in ONE statement before the caller's first query", async () => {
    executed.length = 0;
    transactions.n = 0;
    const runner = new PrismaTenantService();
    await runner.runAsTenant({ schoolId: "s", userId: "u" }, async () => {
      // BUDGET: exactly one statement before the handler gets the transaction.
      expect(executed).toHaveLength(1);
      expect(executed[0]).toMatch(/app\.current_school_id[\s\S]*app\.current_user_id/);
    });
    expect(transactions.n).toBe(1);
  });

  it("the read-only runner: SET TRANSACTION READ ONLY, then the same ONE statement", async () => {
    executed.length = 0;
    const runner = new PrismaTenantService();
    await runner.runAsTenantReadOnly({ schoolId: "s", userId: "u" }, async () => {
      expect(executed).toHaveLength(2);
      expect(executed[0]).toBe("SET TRANSACTION READ ONLY");
      expect(executed[1]).toMatch(/app\.current_school_id[\s\S]*app\.current_user_id/);
    });
  });
});

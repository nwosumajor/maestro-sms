// =============================================================================
// Remembering "holds no grant" must never hide a grant, or outlive a revoke
// =============================================================================
// The PermissionGuard read a user's active elevation grants on EVERY request —
// a transaction of its own — and almost always found none. GrantAbsenceCache
// remembers that NEGATIVE answer so the common request skips the read. What
// makes that safe, and what these tests pin:
//   1. a remembered "none" skips the database (the point of it);
//   2. a user who HOLDS a grant is read every time, so a revoke applies on the
//      next request — the cache can never extend what somebody may do;
//   3. an activation clears it at once, including one that commits DURING a
//      request's read (the race the epoch exists for);
//   4. a failed read is not remembered as "none";
//   5. "none" expires, bounding how late a grant heard nowhere can be;
//   6. every path that makes a grant ACTIVE announces it, and a PENDING
//      request does not.
// =============================================================================

import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";

jest.mock("../../src/auth/jwt", () => ({
  verifyToken: () => ({ userId: "u", schoolId: "s", roles: [] as string[], permissions: [] as string[] }),
}));

import { PermissionGuard } from "../../src/auth/permission.guard";
import { PUBLIC_KEY } from "../../src/auth/public.decorator";
import { MODULE_KEY } from "../../src/auth/require-module.decorator";
import { PERMISSION_KEY } from "../../src/auth/require-permission.decorator";
import { STEPUP_KEY } from "../../src/auth/require-stepup.decorator";
import { GRANT_ABSENCE_TTL_MS, GrantAbsenceCache } from "../../src/foundation/grant-absence-cache.service";
import { SecurityService } from "../../src/security/security.service";

const ctx = (): ExecutionContext => {
  const req = { headers: { authorization: "Bearer t" } } as { principal?: { permissions: string[] } };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader: jest.fn() }) }),
    getHandler: () => null,
    getClass: () => null,
  } as unknown as ExecutionContext;
};

const reflector = (perm: string | undefined): Reflector =>
  ({
    getAllAndOverride: (key: string) =>
      ({ [PUBLIC_KEY]: undefined, [MODULE_KEY]: undefined, [PERMISSION_KEY]: perm, [STEPUP_KEY]: false })[key],
  }) as unknown as Reflector;

/** A tenant runner whose grant read the test controls, counting every read. */
function world(cache = new GrantAbsenceCache()) {
  const state = {
    grants: [] as string[],
    reads: 0,
    fail: false,
    duringRead: undefined as undefined | (() => void),
  };
  const db = {
    runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) =>
      fn({
        privilegeGrant: {
          findMany: async () => {
            state.reads++;
            if (state.fail) throw new Error("db down");
            const rows = state.grants.map((permission) => ({ permission }));
            state.duringRead?.();
            return rows;
          },
          findFirst: async () => ({ id: "g1" }),
        },
      }),
    ),
  };
  const guard = new PermissionGuard(
    reflector(undefined),
    db as never,
    { record: jest.fn() } as never,
    { isEnabled: jest.fn().mockResolvedValue(true) } as never,
    { forRoles: jest.fn().mockResolvedValue([]) } as never,
    { consume: jest.fn().mockResolvedValue({ allowed: true, limit: 1, remaining: 1, resetMs: 1 }) } as never,
    { isActive: async () => true } as never,
    cache,
  );
  return { state, guard, cache };
}

describe("GrantAbsenceCache in the PermissionGuard", () => {
  it("1. a remembered 'none' skips the grant read", async () => {
    const { state, guard } = world();
    for (let i = 0; i < 5; i++) await guard.canActivate(ctx());
    expect(state.reads).toBe(1);
  });

  it("2. a user who HOLDS a grant is read every request, so a revoke applies on the next", async () => {
    const { state, guard } = world();
    state.grants = ["hr.read"];
    await guard.canActivate(ctx());
    await guard.canActivate(ctx());
    expect(state.reads).toBe(2);
    state.grants = []; // revoked
    const c = ctx();
    await guard.canActivate(c);
    expect(state.reads).toBe(3);
    const req = c.switchToHttp().getRequest<{ principal?: { permissions: string[] } }>();
    expect(req.principal?.permissions ?? []).not.toContain("hr.read");
  });

  it("3a. an activation clears 'none' — the new grant is honoured on the next request", async () => {
    const { state, guard, cache } = world();
    await guard.canActivate(ctx()); // remembers none
    state.grants = ["hr.read"];
    cache.granted();
    const c = ctx();
    await guard.canActivate(c);
    expect(state.reads).toBe(2);
    expect(c.switchToHttp().getRequest<{ principal?: { permissions: string[] } }>().principal?.permissions).toContain(
      "hr.read",
    );
  });

  it("3b. a grant that commits DURING a read is not hidden by that read's 'none'", async () => {
    const { state, guard, cache } = world();
    // The read sees no rows; the activation commits and clears before the read
    // returns. Without the epoch, the stale "none" would be stored afterwards.
    state.duringRead = () => {
      state.grants = ["hr.read"];
      cache.granted();
      state.duringRead = undefined;
    };
    await guard.canActivate(ctx());
    await guard.canActivate(ctx());
    expect(state.reads).toBe(2); // asked again — the in-flight "none" was discarded
  });

  it("4. a failed read is not remembered as 'none'", async () => {
    const { state, guard } = world();
    state.fail = true;
    await guard.canActivate(ctx());
    state.fail = false;
    await guard.canActivate(ctx());
    expect(state.reads).toBe(2);
  });

  it("5. 'none' expires after the TTL", () => {
    const cache = new GrantAbsenceCache();
    cache.rememberNone("s", "u", cache.epoch(), 1_000);
    expect(cache.knownToHoldNone("s", "u", 1_000 + GRANT_ABSENCE_TTL_MS - 1)).toBe(true);
    expect(cache.knownToHoldNone("s", "u", 1_000 + GRANT_ABSENCE_TTL_MS)).toBe(false);
  });

  it("5b. keyed by school AND user — one user's 'none' says nothing about another", () => {
    const cache = new GrantAbsenceCache();
    cache.rememberNone("s", "u", cache.epoch());
    expect(cache.knownToHoldNone("s", "other")).toBe(false);
    expect(cache.knownToHoldNone("other-school", "u")).toBe(false);
  });

  it("5c. an activation reaches every task: a remote clear message empties this one", () => {
    let remote: (() => void) | undefined;
    const pubsub = { subscribe: (_ch: string, h: () => void) => (remote = h), publish: jest.fn() };
    const cache = new GrantAbsenceCache(pubsub as never);
    cache.onModuleInit();
    cache.rememberNone("s", "u", cache.epoch());
    remote!();
    expect(cache.knownToHoldNone("s", "u")).toBe(false);
    cache.granted();
    expect(pubsub.publish).toHaveBeenCalledWith("grants:activated", {});
  });
});

describe("6. every path that makes a grant ACTIVE announces it", () => {
  function security() {
    const cache = new GrantAbsenceCache();
    const granted = jest.spyOn(cache, "granted");
    const tx = {
      privilegeGrant: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "g", ...data })),
        findFirst: jest.fn(async () => ({ id: "g", status: "PENDING", requestedById: "other", permission: "hr.read" })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "g", ...data })),
      },
      user: { findFirst: jest.fn(async () => ({ id: "v", name: "V" })) },
    };
    const db = { runAsTenant: async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) };
    const svc = new SecurityService(db as never, { record: jest.fn() } as never, cache);
    const p = { userId: "u", schoolId: "s", roles: [], permissions: ["hr.read"] };
    return { svc, granted, p };
  }

  it("break-glass (ACTIVE on creation) announces; a PENDING request does not", async () => {
    const a = security();
    await a.svc.requestElevation(a.p as never, { permission: "hr.read", reason: "r" } as never);
    expect(a.granted).not.toHaveBeenCalled();
    await a.svc.requestElevation(a.p as never, { permission: "hr.read", reason: "r", breakGlass: true } as never);
    expect(a.granted).toHaveBeenCalledTimes(1);
  });

  it("a handover announces", async () => {
    const a = security();
    await a.svc.delegateElevation(a.p as never, { userId: "v", permission: "hr.read", reason: "cover" });
    expect(a.granted).toHaveBeenCalledTimes(1);
  });

  it("an approval announces", async () => {
    const a = security();
    await a.svc.approveElevation(a.p as never, "g");
    expect(a.granted).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// A route gated on the applicant's permission that only a reviewer should reach
// =============================================================================
// `RequirePermission` took exactly one permission, so every route was gated on
// exactly one. That is right almost everywhere and wrong where one action is
// reached by genuinely different people.
//
// The scholarship stage decision is the case. One application, one decision
// endpoint, three kinds of decider: a class supervisor and a guardian arrive
// holding `scholarship.apply`, and the school's final reviewer decides by
// `workflow.review.principal`. Gating it on the applicant's permission meant
// the only way to let a deputy stand in for an absent principal was to also
// make them an applicant for scholarships — a grant with nothing to do with
// the duty being delegated, handed out to fix an unrelated problem.
//
// So the gate now takes several, meaning ANY ONE opens the route. What it must
// NOT become is a way to soften a gate: a caller holding none of them is still
// refused, and the service still narrows to the caller's real relationship to
// the row. These tests pin both halves.
// =============================================================================

import { ForbiddenException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";

const principal = { userId: "u", schoolId: "s", roles: [] as string[], permissions: [] as string[] };
jest.mock("../../src/auth/jwt", () => ({ verifyToken: () => principal }));

import { PermissionGuard } from "../../src/auth/permission.guard";
import { PUBLIC_KEY } from "../../src/auth/public.decorator";
import { MODULE_KEY } from "../../src/auth/require-module.decorator";
import { PERMISSION_KEY, RequirePermission } from "../../src/auth/require-permission.decorator";
import { STEPUP_KEY } from "../../src/auth/require-stepup.decorator";

/**
 * A school that is switched ON. The guard refuses every request from a DISABLED
 * school now — these suites are about permissions and modules, so the school is
 * active and that check is a no-op.
 */
const activeSchool = () => ({ isActive: async () => true }) as never;


function makeCtx(): ExecutionContext {
  const req = { headers: { authorization: "Bearer token" } };
  const res = { setHeader: jest.fn() };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => null,
    getClass: () => null,
  } as unknown as ExecutionContext;
}

const allowRate = { consume: jest.fn().mockResolvedValue({ allowed: true, limit: 1200, remaining: 1199, resetMs: 60_000 }) };

function reflectorFor(declared: unknown): Reflector {
  const map: Record<string, unknown> = {
    [PUBLIC_KEY]: undefined,
    [MODULE_KEY]: undefined,
    [PERMISSION_KEY]: declared,
    [STEPUP_KEY]: false,
  };
  return { getAllAndOverride: (key: string) => map[key] } as unknown as Reflector;
}

function guardFor(declared: unknown, grants: string[] = []) {
  const db = {
    runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) =>
      fn({ privilegeGrant: { findMany: async () => grants.map((permission) => ({ permission })) } }),
    ),
  };
  return new PermissionGuard(
    reflectorFor(declared),
    db as never,
    { record: jest.fn() } as never,
    { isEnabled: jest.fn().mockResolvedValue(true) } as never,
    { forRoles: jest.fn().mockResolvedValue([]) } as never,
    allowRate as never,
        activeSchool(),
      );
}

afterEach(() => {
  principal.permissions = [];
  principal.roles = [];
});

describe("a route that names ONE permission", () => {
  // Every existing route in the app. Nothing about these may change.
  it("opens for a holder", async () => {
    principal.permissions = ["fee.manage"];
    await expect(guardFor("fee.manage").canActivate(makeCtx())).resolves.toBe(true);
  });

  it("is refused for a non-holder", async () => {
    principal.permissions = ["fee.read"];
    await expect(guardFor("fee.manage").canActivate(makeCtx())).rejects.toThrow(ForbiddenException);
  });

  it("still opens on an active elevation grant", async () => {
    // Elevation is additive to the JWT — the property the guard exists to hold.
    await expect(guardFor("fee.manage", ["fee.manage"]).canActivate(makeCtx())).resolves.toBe(true);
  });
});

describe("a route that names SEVERAL", () => {
  const both = ["scholarship.apply", "workflow.review.principal"];

  it("opens for the applicant side", async () => {
    principal.permissions = ["scholarship.apply"];
    await expect(guardFor(both).canActivate(makeCtx())).resolves.toBe(true);
  });

  it("opens for the reviewer side — the delegate who is not an applicant", async () => {
    principal.permissions = ["workflow.review.principal"];
    await expect(guardFor(both).canActivate(makeCtx())).resolves.toBe(true);
  });

  it("refuses somebody holding NEITHER", async () => {
    // The listed permissions widen who may reach the route. They do not make it
    // open: an accountant holds neither and is refused exactly as before.
    principal.permissions = ["fee.manage", "student.read"];
    await expect(guardFor(both).canActivate(makeCtx())).rejects.toThrow(ForbiddenException);
  });

  it("refuses a caller holding nothing at all", async () => {
    await expect(guardFor(both).canActivate(makeCtx())).rejects.toThrow(ForbiddenException);
  });

  it("honours an elevation grant for the SECOND of them", async () => {
    // The grant lookup asks for every active grant, not the first listed
    // permission — so a grant for any accepted permission opens the route.
    await expect(guardFor(both, ["workflow.review.principal"]).canActivate(makeCtx())).resolves.toBe(true);
  });
});

describe("the decorator's metadata", () => {
  function metaOf(...perms: string[]) {
    class Route {
      handler() { return undefined; }
    }
    const descriptor = Object.getOwnPropertyDescriptor(Route.prototype, "handler") as PropertyDescriptor;
    RequirePermission(...perms)(Route.prototype, "handler", descriptor);
    return Reflect.getMetadata(PERMISSION_KEY, descriptor.value as object) as unknown;
  }

  it("emits a bare string for one permission", () => {
    // Back-compat that matters: every existing route emits the shape it always
    // did, so nothing else reading PERMISSION_KEY has to learn a second one.
    expect(metaOf("fee.manage")).toBe("fee.manage");
  });

  it("emits an array only when there are several", () => {
    expect(metaOf("scholarship.apply", "workflow.review.principal")).toEqual([
      "scholarship.apply",
      "workflow.review.principal",
    ]);
  });
});

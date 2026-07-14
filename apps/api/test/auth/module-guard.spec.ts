// Unit: the PermissionGuard's module-entitlement gate. A route tagged with a
// @RequireModule the school's plan doesn't include returns 404 (never-leak),
// before any permission check; an enabled module passes through.

import { NotFoundException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";

// The guard authenticates from a Bearer JWT; stub that out so we can drive just
// the module branch with a synthetic principal.
const principal = { userId: "u", schoolId: "s", roles: [], permissions: [] };
jest.mock("../../src/auth/jwt", () => ({ verifyToken: () => principal }));

import { PermissionGuard } from "../../src/auth/permission.guard";
import { PUBLIC_KEY } from "../../src/auth/public.decorator";
import { MODULE_KEY } from "../../src/auth/require-module.decorator";
import { PERMISSION_KEY } from "../../src/auth/require-permission.decorator";
import { STEPUP_KEY } from "../../src/auth/require-stepup.decorator";

function makeCtx(): ExecutionContext {
  const req = { headers: { authorization: "Bearer token" } };
  const res = { setHeader: jest.fn() };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => null,
    getClass: () => null,
  } as unknown as ExecutionContext;
}

// Rate limiter that always allows (the default for these module-gate tests).
const allowRate = { consume: jest.fn().mockResolvedValue({ allowed: true, limit: 1200, remaining: 1199, resetMs: 60_000 }) };

function makeReflector(requiredModule: string): Reflector {
  const map: Record<string, unknown> = {
    [PUBLIC_KEY]: undefined,
    [MODULE_KEY]: requiredModule,
    [PERMISSION_KEY]: undefined,
    [STEPUP_KEY]: false,
  };
  return { getAllAndOverride: (key: string) => map[key] } as unknown as Reflector;
}

describe("PermissionGuard — module entitlement gate", () => {
  it("404s when the school's plan does NOT include the route's module", async () => {
    const modules = { isEnabled: jest.fn().mockResolvedValue(false) };
    const guard = new PermissionGuard(
      makeReflector("fees"),
      {} as never,
      {} as never,
      modules as never,
      allowRate as never,
    );
    await expect(guard.canActivate(makeCtx())).rejects.toThrow(NotFoundException);
    expect(modules.isEnabled).toHaveBeenCalledWith("s", "fees");
  });

  it("passes when the module IS enabled (and no permission/step-up required)", async () => {
    const modules = { isEnabled: jest.fn().mockResolvedValue(true) };
    const guard = new PermissionGuard(
      makeReflector("fees"),
      {} as never,
      {} as never,
      modules as never,
      allowRate as never,
    );
    await expect(guard.canActivate(makeCtx())).resolves.toBe(true);
  });

  it("429s when the tenant is over its per-school rate budget (before any module/DB work)", async () => {
    const modules = { isEnabled: jest.fn().mockResolvedValue(true) };
    const denyRate = { consume: jest.fn().mockResolvedValue({ allowed: false, limit: 100, remaining: 0, resetMs: 30_000 }) };
    const guard = new PermissionGuard(
      makeReflector("fees"),
      {} as never,
      {} as never,
      modules as never,
      denyRate as never,
    );
    await expect(guard.canActivate(makeCtx())).rejects.toMatchObject({ status: 429 });
    // Rejected cheaply — the module gate never ran.
    expect(modules.isEnabled).not.toHaveBeenCalled();
  });
});

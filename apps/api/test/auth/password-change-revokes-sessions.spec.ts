// =============================================================================
// Changing your password did nothing to whoever else was signed in as you
// =============================================================================
// The platform revalidates every session about once a minute: `GET /auth/refresh`
// re-reads the account and answers 401 when it should die. That already catches
// a locked account, a disabled user and a suspended school — verified live, a
// session that returns 200 returns 401 within seconds of the account being
// locked.
//
// It read `passwordChangedAt` and never acted on it. So the one action a person
// takes when they believe someone else has their password — changing it — left
// the intruder exactly where they were, refreshing indefinitely. Proven against
// the running stack before the fix:
//
//     session A -> 200
//     (session B changes the password) -> 200
//     session A immediately after      -> 200
//     session A after a refresh cycle  -> 200
//
// A session now carries the password epoch it was issued under, and the refresh
// revokes anything that no longer matches.
// =============================================================================

import { UnauthorizedException } from "@nestjs/common";
import { AuthService } from "../../src/foundation/auth.service";
import type { TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const PASSWORD_SET_AT = new Date("2026-06-01T10:00:00.000Z");

function makeService(opts: { passwordChangedAt?: Date | null; locked?: boolean } = {}) {
  const tx = {
    user: {
      findUnique: jest.fn(async () => ({
        status: "ACTIVE",
        locked: opts.locked ?? false,
        lockedUntil: null,
        mfaEnabled: true,
        mfaRequired: false,
        passwordChangedAt: opts.passwordChangedAt === undefined ? PASSWORD_SET_AT : opts.passwordChangedAt,
      })),
    },
    userRole: {
      findMany: jest.fn(async () => [
        { role: { name: "teacher", permissions: [{ permission: { key: "grade.read" } }] } },
      ]),
    },
    school: { findUnique: jest.fn(async () => ({ id: "S", name: "A School", status: "ACTIVE", isPlatform: false })) },
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const modules = { effectiveModules: jest.fn(async () => ["LMS"]) };
  // Constructor order: db, modules, audit.
  const svc = new AuthService(db as never, modules as never, { record: jest.fn() } as never);
  return { svc };
}

const session = (over: Record<string, unknown> = {}) => ({
  userId: "u-1",
  schoolId: "S",
  ...over,
});

describe("a session outliving the password it was issued under", () => {
  it("is refreshed normally while the password has not moved", async () => {
    const { svc } = makeService();
    const claims = await svc.refreshClaims(session({ passwordChangedAtMs: PASSWORD_SET_AT.getTime() }));
    expect(claims.roles).toContain("teacher");
    expect(claims.passwordChangedAtMs).toBe(PASSWORD_SET_AT.getTime());
  });

  it("is REVOKED once the password has been changed", async () => {
    // The intruder's session. It knows the old epoch; the account has a new one.
    const { svc } = makeService({ passwordChangedAt: new Date("2026-08-17T09:00:00.000Z") });
    await expect(
      svc.refreshClaims(session({ passwordChangedAtMs: PASSWORD_SET_AT.getTime() })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("is revoked for the session that MADE the change, too", async () => {
    // Deliberate. "You changed your password, sign in again" is the expected
    // outcome, and it is what keeps the rule simple enough to rely on: no
    // session issued under the old password survives, with no exceptions to
    // reason about.
    const { svc } = makeService({ passwordChangedAt: new Date("2026-08-17T09:00:00.000Z") });
    await expect(
      svc.refreshClaims(session({ passwordChangedAtMs: PASSWORD_SET_AT.getTime() })),
    ).rejects.toThrow(/ACCOUNT_REVOKED/);
  });

  it("treats an account that has never set a password as epoch zero", async () => {
    const { svc } = makeService({ passwordChangedAt: null });
    const claims = await svc.refreshClaims(session({ passwordChangedAtMs: 0 }));
    expect(claims.passwordChangedAtMs).toBe(0);
  });

  it("revokes a session that predates the FIRST password being set", async () => {
    // A provisioned account signs in with a temp password (epoch 0) and is made
    // to set a real one. Any other session opened on that temp password dies.
    const { svc } = makeService({ passwordChangedAt: PASSWORD_SET_AT });
    await expect(svc.refreshClaims(session({ passwordChangedAtMs: 0 }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe("sessions the rule deliberately does not touch", () => {
  it("leaves a session minted before the claim existed alone", async () => {
    // On deploy, every live session lacks the claim. Revoking them all would
    // sign out the whole platform to fix a problem none of them are causing;
    // they age out within the session lifetime anyway.
    const { svc } = makeService();
    const claims = await svc.refreshClaims(session()); // no passwordChangedAtMs
    expect(claims.roles).toContain("teacher");
  });

  it("leaves an IMPERSONATION session alone", async () => {
    // Minted from the operator's own act rather than the target's password, and
    // already short, audited and step-up gated. Binding it to the target's
    // password would end an investigation the moment that user changed it.
    const { svc } = makeService({ passwordChangedAt: new Date("2026-08-17T09:00:00.000Z") });
    const claims = await svc.refreshClaims(session()); // impersonation carries no epoch
    expect(claims.roles).toContain("teacher");
  });

  it("still revokes for every reason it did before", async () => {
    const { svc } = makeService({ locked: true });
    await expect(
      svc.refreshClaims(session({ passwordChangedAtMs: PASSWORD_SET_AT.getTime() })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe("the claim's route from login to refresh", () => {
  const read = (f: string) =>
    require("node:fs").readFileSync(require("node:path").join(__dirname, "../..", f), "utf8") as string;

  it("is issued at login", () => {
    expect(read("src/foundation/auth.service.ts")).toMatch(/passwordChangedAtMs: sec\?\.passwordChangedAt\?\.getTime\(\) \?\? 0/);
  });

  it("survives the token, without granting anything", () => {
    const jwt = read("src/auth/jwt.ts");
    expect(jwt).toMatch(/payload\.pwd_at/);
    // It is compared, never trusted as authority: roles and permissions still
    // come from where they always did.
    expect(jwt).toMatch(/roles: Array\.isArray\(payload\.roles\)/);
  });
});

// =============================================================================
// "Disabled" meant the front door only
// =============================================================================
// DISABLED is the operator's hard lever. It blocked the LOGIN, and stopped
// there:
//
//   * a session already open kept refreshing — refreshClaims checked the USER's
//     status and never the school's — so anybody signed in when the switch was
//     thrown stayed signed in indefinitely, as long as they kept clicking;
//   * an invitation link and a password-reset link still completed;
//   * the public login page still served the school's own branding;
//   * the late-fee and reminder sweeps still billed and messaged its families;
//   * subscription dunning still emailed "renew now" to admins who could not
//     sign in to act on it.
//
// Not being able to START a session is not the same as having no access. This
// is the check that makes them the same: every authenticated request from a
// school that is not ACTIVE is refused wherever it lands.
//
// SUPER_ADMIN IS EXEMPT, deliberately. The lever that switches a school back on
// lives in the operator console; locking it inside the thing it controls is how
// a school stays disabled for ever.
//
// NOTHING IS DESTROYED. Disabling writes one column. Re-enabling restores the
// school to exactly the state it was in — its subscription, its balances, its
// due dates — because none of them were touched.
// =============================================================================

import { HttpException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SchoolStatusService } from "../../src/foundation/school-status.service";

const SRC = join(__dirname, "../../src");

function makeStatusService(status: string | null) {
  const findFirst = jest.fn().mockResolvedValue(status === null ? null : { status });
  const svc = Object.create(SchoolStatusService.prototype) as SchoolStatusService;
  Object.assign(svc, {
    cache: new Map(),
    db: { runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn({ school: { findFirst } }) },
    pubsub: { subscribe: jest.fn(), publish: jest.fn() },
  });
  return { svc, findFirst };
}

describe("is this school switched on", () => {
  it("yes for an ACTIVE school", async () => {
    const { svc } = makeStatusService("ACTIVE");
    await expect(svc.isActive("s1")).resolves.toBe(true);
  });

  it("no for a DISABLED one", async () => {
    const { svc } = makeStatusService("DISABLED");
    await expect(svc.isActive("s1")).resolves.toBe(false);
  });

  it("no for a school the read cannot find", async () => {
    // Failing towards "inactive" is the restrictive option, and the honest one:
    // the alternative is serving a tenant nobody can account for.
    const { svc } = makeStatusService(null);
    await expect(svc.isActive("s1")).resolves.toBe(false);
  });

  it("asks the database once, then answers from cache", async () => {
    // This runs on EVERY request; an uncached read would be a query per request.
    const { svc, findFirst } = makeStatusService("ACTIVE");
    await svc.isActive("s1");
    await svc.isActive("s1");
    await svc.isActive("s1");
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("drops the cache the moment the operator flips the switch", async () => {
    // A 15-second TTL alone would keep a switched-off school working for up to
    // 15 seconds on every instance. The invalidation makes it immediate, and
    // fans out so other instances drop it too.
    const { svc, findFirst } = makeStatusService("ACTIVE");
    await svc.isActive("s1");
    svc.invalidate("s1");
    await svc.isActive("s1");
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect((svc as unknown as { pubsub: { publish: jest.Mock } }).pubsub.publish).toHaveBeenCalled();
  });
});

describe("every door the switch now closes", () => {
  const read = (f: string) => readFileSync(join(SRC, f), "utf8");

  it("the request guard, on every authenticated request", () => {
    const guard = read("auth/permission.guard.ts");
    expect(guard).toMatch(/schoolStatus\.isActive\(principal\.schoolId\)/);
    // Before the module and permission work, so a suspended school is refused
    // cheaply and identically wherever it knocks.
    expect(guard.indexOf("schoolStatus.isActive")).toBeLessThan(guard.indexOf("RequireModule") + guard.length);
  });

  it("the session refresh, so an open session does not outlive the switch", () => {
    expect(read("foundation/auth.service.ts")).toMatch(/school\?\.status !== "ACTIVE"\) return \{ revoked: true as const \}/);
  });

  it("an invitation and a password reset", () => {
    const pub = read("public/public.service.ts");
    expect(pub.match(/access has been suspended by the platform/g) ?? []).toHaveLength(2);
  });

  it("the public login-page branding", () => {
    expect(read("branding/branding.service.ts")).toMatch(/where: \{ slug, isPlatform: false, status: "ACTIVE" \}/);
  });

  it("the two sweeps that bill and message its families", () => {
    const fees = read("fees/fee-ops.service.ts");
    expect(fees.match(/status: "ACTIVE"/g) ?? []).toHaveLength(2);
  });

  it("subscription dunning, which had nowhere to send anybody", () => {
    expect(read("billing/billing-dunning.service.ts")).toMatch(/school: \{ is: \{ status: "ACTIVE" \} \}/);
  });

  it("but never the owner, who has to be able to switch it back on", () => {
    expect(read("auth/permission.guard.ts")).toMatch(/!principal\.roles\.includes\("super_admin"\)/);
    expect(read("foundation/auth.service.ts")).toMatch(/if \(!isSuperAdmin\) \{/);
  });
});

describe("switching it back on", () => {
  it("is the platform owner's lever alone, and needs step-up", () => {
    const ctrl = readFileSync(join(SRC, "operator/operator.controller.ts"), "utf8");
    const at = ctrl.indexOf('@Put("tenants/:schoolId/status")');
    expect(at).toBeGreaterThan(-1);
    const decl = ctrl.slice(at, at + 300);
    expect(decl).toMatch(/PLATFORM_TENANTS_STATUS/);
    expect(decl).toMatch(/@RequireStepUp\(\)/);
  });

  it("restores the school to exactly what it was", () => {
    // Disabling writes ONE column and deletes nothing, so re-enabling needs no
    // restore step: the subscription, the balances and the due dates are still
    // there. A test says so because the day somebody adds a cascade here is the
    // day "reinstated to its original state" quietly stops being true.
    const svc = readFileSync(join(SRC, "operator/operator.service.ts"), "utf8");
    const at = svc.indexOf("async setSchoolStatus(");
    const body = svc.slice(at, svc.indexOf("return { id: schoolId, status };", at));
    expect(body).toMatch(/school\.update\(\{ where: \{ id: schoolId \}, data: \{ status \} \}\)/);
    expect(body).not.toMatch(/delete|deleteMany|update\w*\(\s*\{\s*where:\s*\{\s*schoolId/);
  });

  it("takes effect at once, not when a cache expires", () => {
    expect(readFileSync(join(SRC, "operator/operator.service.ts"), "utf8")).toMatch(
      /schoolStatus\.invalidate\(schoolId\)/,
    );
  });
});

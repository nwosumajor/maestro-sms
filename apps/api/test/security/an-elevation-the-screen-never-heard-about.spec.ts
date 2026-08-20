// =============================================================================
// An elevation the API honoured and the product hid
// =============================================================================
// JIT elevation is this platform's answer to an absent colleague: request it, a
// DIFFERENT person approves, it expires by itself, every use is audited. The
// guard merges an active grant into `principal.permissions`, so the API honours
// it — and the browser never heard about it.
//
// The web session deliberately carries ROLES only (a principal's ~97 permission
// strings pushed the cookie past nginx's 4 KB header buffer), expanding them
// through the same role map the seed writes. Correct for a role, and blind to a
// grant, which is by definition not derivable from one. GET /auth/refresh —
// which exists so mid-session changes take effect — read role rows and stopped
// there.
//
// Measured live before the fix, one teacher, one ACTIVE approved grant for
// hr.read:
//
//     API   /hr/employees  →  200, 14 employees
//     PAGE  /hr            →  redirected to /dashboard
//
// So elevation worked for anyone willing to call the API by hand, and for nobody
// using the product. Nav entries, dashboard tiles and page gates all read the
// session, so this was every screen, not one.
//
// Both halves must resolve a grant the SAME way or they drift again, which is
// why `activeGrantPermissions` is one function with two callers.
// =============================================================================

import { activeGrantPermissions } from "../../src/auth/active-grants";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AUTH_SERVICE = readFileSync(join(__dirname, "../../src/foundation/auth.service.ts"), "utf8");
const GUARD = readFileSync(join(__dirname, "../../src/auth/permission.guard.ts"), "utf8");

describe("one definition of what an elevation gives you", () => {
  it("is shared by the guard and the claims, not copied", () => {
    // The drift this prevents is the defect itself: two answers to "does this
    // grant count", one used to authorize and one used to render.
    expect(GUARD).toMatch(/activeGrantPermissions\(tx, principal\.userId\)/);
    expect(AUTH_SERVICE).toMatch(/activeGrantPermissions\(tx, user\.id\)/);
    expect(AUTH_SERVICE).toMatch(/activeGrantPermissions\(tx, p\.userId\)/);
    // And nobody re-queries the table by hand alongside it.
    expect(AUTH_SERVICE).not.toMatch(/privilegeGrant\.findMany/);
  });

  it("is resolved on BOTH the login and the refresh path", () => {
    // Login alone would leave a grant issued mid-session invisible until the
    // next sign-in; refresh alone would leave the first minute after sign-in
    // wrong. The refresh also carries the EXPIRY, which is the half that
    // matters more — an affordance outliving its grant is a refusal the user
    // was invited to trigger.
    expect((AUTH_SERVICE.match(/const elevated = \(await activeGrantPermissions/g) ?? [])).toHaveLength(2);
    expect((AUTH_SERVICE.match(/^\s+elevated,$/gm) ?? [])).toHaveLength(2);
  });

  it("names only what is genuinely borrowed", async () => {
    // A grant duplicating a permission the role already carries is not
    // elevation, and listing it would let the UI describe a screen the user
    // owns outright as being on loan.
    const rows = [{ permission: "hr.read" }, { permission: "attendance.write" }];
    const tx = { privilegeGrant: { findMany: async () => rows } } as never;
    const all = await activeGrantPermissions(tx, "u-1");
    const rolePerms = ["attendance.write", "student.read"];
    expect(all.filter((perm) => !rolePerms.includes(perm))).toEqual(["hr.read"]);
  });
});

describe("what the claim may carry", () => {
  it("never a platform or maker-checker permission, whatever the row says", async () => {
    // The UI showing an affordance is not authorization — but a UI that offers
    // `platform.operate` because a tampered row exists sends a school user to a
    // cross-tenant screen to be refused, and tells them the platform thinks
    // they might have it. The same filter that protects the gate protects this.
    const rows = [
      { permission: "platform.operate" },
      { permission: "billing.manage" },
      { permission: "rbac.manage" },
      { permission: "hr.salary.approve" },
      { permission: "fee.approve" },
      { permission: "security.elevation.approve" },
      { permission: "game.ultimate.admin" },
      { permission: "hr.read" },
    ];
    const tx = { privilegeGrant: { findMany: async () => rows } } as never;
    await expect(activeGrantPermissions(tx, "u-1")).resolves.toEqual(["hr.read"]);
  });

  it("nothing at all when the user has no grants", async () => {
    const tx = { privilegeGrant: { findMany: async () => [] } } as never;
    await expect(activeGrantPermissions(tx, "u-1")).resolves.toEqual([]);
  });
});

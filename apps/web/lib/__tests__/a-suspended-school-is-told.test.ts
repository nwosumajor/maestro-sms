// =============================================================================
// A whole app of empty panels, and no reason for any of it
// =============================================================================
// Once the platform switches a school off, EVERY authenticated read returns 403.
// `apiGet` answers a plain 403 with `null` — right for a missing permission,
// because half the app's pages read something their caller may lack — and
// useless here: the user would land on page after page of empty cards with
// nothing anywhere saying what had happened, or that their data was still
// there.
//
// So the API tags that one case with a shared code and the web sends them to a
// page that says it. The code lives in @sms/types because BOTH sides have to
// agree on it; a literal on either side is a contract nobody checks.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHOOL_SUSPENDED_CODE } from "@sms/types";

const API = readFileSync(join(__dirname, "../api.ts"), "utf8");
const GUARD = readFileSync(
  join(__dirname, "../../../api/src/auth/permission.guard.ts"),
  "utf8",
);
const PAGE = readFileSync(join(__dirname, "../../app/(app)/suspended/page.tsx"), "utf8");
/** Comments stripped: the page EXPLAINS in prose why it calls no apiGet, and an
 *  assertion that reads prose as code would match that explanation. */
const PAGE_CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the two sides of the same 403", () => {
  it("the API tags a suspension with the shared code", () => {
    expect(GUARD).toMatch(/code: SCHOOL_SUSPENDED_CODE/);
    expect(GUARD).not.toMatch(/code: "SCHOOL_SUSPENDED"/); // never a literal
  });

  it("the web recognises it and redirects, rather than returning null", () => {
    const at = API.indexOf("if (res.status === 403)");
    const branch = API.slice(at, at + 900);
    expect(branch).toMatch(/SCHOOL_SUSPENDED_CODE/);
    expect(branch).toMatch(/redirect\("\/suspended"\)/);
  });

  it("still answers an ordinary permission 403 with null", () => {
    // The redirect must not swallow the common case: a page reading something
    // its reader lacks gets null and renders its own empty state, as before.
    const at = API.indexOf("if (res.status === 403)");
    // Wide enough to reach the fall-through: the branch carries a long comment,
    // and a window that stopped short would "prove" the null was gone.
    const branch = API.slice(at, at + 1400);
    expect(branch).toMatch(/return null;/);
    expect(branch.indexOf("redirect(")).toBeLessThan(branch.indexOf("return null;"));
  });

  it("agrees on one value, defined once", () => {
    expect(SCHOOL_SUSPENDED_CODE).toBe("SCHOOL_SUSPENDED");
  });
});

describe("the login screen, which is where they actually end up", () => {
  // The session revocation added alongside this fires FIRST — refreshClaims
  // revokes a rolling session for a switched-off school — so in practice the
  // user is signed out and lands on /login, and /suspended is only the safety
  // net for the narrow window where a server component gets the 403 first.
  // Measured live: GET /dashboard → 307 /login, and the sign-in itself then
  // returns `?error=CredentialsSignin&code=SCHOOL_SUSPENDED`.
  const AUTH = readFileSync(join(__dirname, "../auth.ts"), "utf8");
  const FORM = readFileSync(join(__dirname, "../../components/auth/LoginForm.tsx"), "utf8");

  it("carries the reason through Auth.js instead of discarding it", () => {
    expect(AUTH).toMatch(/err\.code = SCHOOL_SUSPENDED_CODE/);
  });

  it("still refuses a wrong password without saying which half was wrong", () => {
    // Naming the suspension is safe — nobody at the school can act on it either
    // way. Naming a bad password or a locked account is an oracle.
    // Anchored on the suspension branch, not the first `if (!res.ok)` in the
    // file — there are several, and the first belongs to the refresh call.
    const at = AUTH.indexOf("err.code = SCHOOL_SUSPENDED_CODE");
    expect(at).toBeGreaterThan(-1);
    expect(AUTH.slice(at, at + 300)).toMatch(/return null; \/\/ invalid credentials/);
  });

  it("the form says what happened, and that nothing was deleted", () => {
    expect(FORM).toMatch(/res\.code === SCHOOL_SUSPENDED_CODE/);
    expect(FORM).toMatch(/Nothing has been deleted/);
    expect(FORM).toMatch(/contact your provider/);
  });

  it("no longer buries suspension inside the wrong-password sentence", () => {
    // The old catch-all listed it as one possibility among several, which sent
    // people to check a password that was never the problem.
    const at = FORM.indexOf("Invalid email, password, or 2FA code");
    expect(FORM.slice(at, at + 240)).not.toMatch(/suspended/i);
  });
});

describe("what the page tells them", () => {
  it("says who did it, so nobody hunts for a setting at their end", () => {
    expect(PAGE).toMatch(/platform operator, not by anyone at your school/);
  });

  it("says their data is intact, which is the first thing a school will ask", () => {
    expect(PAGE).toMatch(/Nothing has been deleted/);
  });

  it("reads NOTHING, because every read it could make would be refused", () => {
    // A page that called apiGet here would 403, redirect to itself, and loop.
    expect(PAGE_CODE).not.toMatch(/apiGet/);
  });

  it("offers a way out", () => {
    expect(PAGE).toMatch(/SignOutButton/);
  });
});

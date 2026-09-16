/**
 * EIGHT SIGNED-IN SECTIONS THE MIDDLEWARE HAD NEVER HEARD OF.
 *
 * `middleware.ts` gated on a hand-kept `PROTECTED_PREFIXES` list of ~45
 * sections, and the app outgrew it. Missing: `/cbt`, `/exams`, `/feedback`,
 * `/group`, `/kiosk`, `/learning`, `/meetings`, `/reportcards`. Measured against
 * the running app, each answered 200 with NO SESSION.
 *
 * That gate is three controls at once, and all three were skipped there:
 *
 *   1. The 30-day FORCED PASSWORD RESET. A user whose password had expired was
 *      held out of /dashboard and /attendance and could still open /cbt — the
 *      exam hall — and /reportcards, a child's marks. Verified live: the demo
 *      student was redirected from /dashboard and served 200 on both.
 *   2. The per-school MFA MANDATE, identically.
 *   3. The unauthenticated redirect to /login. No data escaped — the page
 *      streams its loading shell and the server component then throws on
 *      `session!.user` — but a visitor gets a page stuck on "Loading" with no
 *      way in and no explanation.
 *
 * The fix is the DEFAULT, not a longer list: everything needs a session unless
 * it is named public. This test is what keeps the two in step, by walking the
 * app router rather than trusting either list.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { PUBLIC_PREFIXES, isPublicRoute } from "@/lib/public-routes";

const WEB = path.join(__dirname, "../..");
const APP = path.join(WEB, "app");
const MIDDLEWARE = readFileSync(path.join(WEB, "middleware.ts"), "utf8");

/** Top-level URL sections that have a page, split by whether they sit under the
 *  signed-in `(app)` shell. Walked from the router, so neither list is trusted. */
function sections(): { signedIn: Set<string>; other: Set<string> } {
  const signedIn = new Set<string>();
  const other = new Set<string>();
  const walk = (dir: string, url: string[], inApp: boolean) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      const group = entry.startsWith("(");
      const nextUrl = group ? url : [...url, entry];
      const nowInApp = inApp || entry === "(app)";
      if (readdirSync(full).includes("page.tsx") && nextUrl.length > 0) {
        (nowInApp ? signedIn : other).add(`/${nextUrl[0]}`);
      }
      walk(full, nextUrl, nowInApp);
    }
  };
  walk(APP, [], false);
  return { signedIn, other };
}

const { signedIn } = sections();
// THE REAL FUNCTION, not a copy. Reimplementing the rule here would prove only
// that the test agrees with itself — and the first draft did exactly that, and
// disagreed with the real one about `/icon.png`.
const isPublic = isPublicRoute;

describe("the signed-in app is default-deny", () => {
  it("found the app's sections and the allowlist", () => {
    // A walk that finds nothing produces no offenders and passes green.
    expect(signedIn.size).toBeGreaterThan(30);
    expect(PUBLIC_PREFIXES.length).toBeGreaterThan(5);
  });

  it("gates on a PUBLIC allowlist, never a list of what to protect", () => {
    // The durable half. A `PROTECTED_PREFIXES` list makes forgetting the unsafe
    // default; this way a new section is protected by existing.
    expect(MIDDLEWARE).toContain("needsSession");
    expect(MIDDLEWARE).not.toContain("PROTECTED_PREFIXES");
  });

  it("treats every section under app/(app) as needing a session", () => {
    // The eight that were open are all under (app): /cbt, /exams, /feedback,
    // /group, /kiosk, /learning, /meetings, /reportcards.
    const open = [...signedIn].filter(isPublic).sort();
    expect(open).toEqual([]);
  });

  it("still lets the public in where the product means to", () => {
    // Widening the RULE would be the opposite mistake — a sign-in page nobody
    // can reach, or a certificate a holder cannot verify.
    for (const p of ["/", "/login", "/reset-password", "/apply", "/verify/card/x/y", "/icon.png"]) {
      expect({ path: p, open: isPublic(p) }).toEqual({ path: p, open: true });
    }
  });

  it("keeps the signed-in documents signed in", () => {
    // /manual and /runbooks are deliberately not public — they are the leader's
    // manual and the on-call runbooks.
    for (const p of ["/manual", "/runbooks/incident-response", "/dashboard", "/cbt", "/reportcards"]) {
      expect({ path: p, open: isPublic(p) }).toEqual({ path: p, open: false });
    }
  });
});

// =============================================================================
// The headers the browser actually receives
// =============================================================================
// The stored-XSS hole this backstops is fixed at its source (see
// test/documents/a-document-cannot-claim-to-be-code.spec.ts). What is pinned
// here is the layer BELOW that: what every response carries regardless.
//
// Two policies, for two different jobs:
//
//   - EVERY response from the web tier gets a baseline. Deliberately no
//     script-src: a real one needs a per-request nonce for the inline bootstrap
//     Next injects, which means running middleware on every route — and this
//     app's middleware is what redirects unauthenticated users, so widening its
//     matcher risks holding public pages hostage or opening a protected one.
//     That is its own change with its own verification. The four directives here
//     need no nonce and cannot break a page: nothing uses <object>/<embed>,
//     nothing sets a <base>, forms are server actions posting to this origin,
//     and the only iframe is the app framing somebody else — which
//     frame-ancestors does not govern.
//
//   - Everything PROXIED from the API is data or a download, never a page, so it
//     is sandboxed into an opaque origin with everything denied.
//
// Verified in a real headless Chrome against the running stack: five pages
// (login, home, dashboard, fees, admin) with an authenticated session produced
// ZERO violations and zero console errors — and the same instrumentation, told
// to inject a <base>, an <object> and a form posting to another host, reported
// all three blocked. A checker that reports nothing has to be shown capable of
// reporting something.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = (p: string) => readFileSync(join(__dirname, "../../../web", p), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the baseline every response carries", () => {
  const config = stripComments(WEB("next.config.mjs"));

  it("applies to every path, not just the app routes", () => {
    // The public pages — login, the marketing home, /apply, /onboard — are
    // exactly the unauthenticated surface, and they are NOT in the middleware's
    // matcher. A header set there would have missed them.
    expect(config).toMatch(/source:\s*"\/:path\*"/);
  });

  it("blocks the injections that need no script to hurt", () => {
    for (const directive of [
      "object-src 'none'",      // plugin content
      "base-uri 'self'",        // rewriting every relative URL on the page
      "form-action 'self'",     // posting a form to somebody else's server
      "frame-ancestors 'self'", // being framed for clickjacking
    ]) {
      expect(config).toContain(directive);
    }
  });

  it("leaves script-src to the page policy, and never fakes one", () => {
    // The real script-src lives in middleware.ts, where a per-request nonce is
    // available. What must never appear ANYWHERE is 'unsafe-inline', which reads
    // as protection while allowing exactly the thing script-src exists to stop.
    expect(config).not.toMatch(/script-src/);
    expect(config).not.toMatch(/unsafe-inline/);
  });

  it("keeps nosniff at the tier that serves the browser", () => {
    expect(config).toContain("X-Content-Type-Options");
  });
});

describe("the page policy", () => {
  const mw = stripComments(WEB("middleware.ts"));

  it("carries a per-request nonce, not a static allowance", () => {
    expect(mw).toMatch(/nonce-\$\{nonce\}/);
    expect(mw).toMatch(/crypto\.randomUUID\(\)/);
  });

  it("sets the policy on the REQUEST as well as the response", () => {
    // Next reads the nonce back out of the request's CSP header to stamp its own
    // inline bootstrap. Set it only on the way out and every page loses its
    // scripts — which is not a subtle failure, but is an invisible one to any
    // check that does not use a browser.
    // Anchored so `res.headers.set(...)` cannot satisfy the request half — the
    // first version of this assertion matched both lines and stayed green when
    // the request header was deleted.
    expect(mw).toMatch(/\n\s*headers\.set\("Content-Security-Policy", csp\);/);
    expect(mw).toMatch(/NextResponse\.next\(\{ request: \{ headers \} \}\)/);
    expect(mw).toMatch(/res\.headers\.set\("Content-Security-Policy", csp\);/);
  });

  it("never allows inline script wholesale", () => {
    expect(mw).not.toMatch(/'unsafe-inline'[^;]*script/);
    expect(mw).not.toMatch(/script-src[^`]*'unsafe-inline'/);
  });

  it("still applies the auth rules to every prefix it used to", () => {
    // The matcher now runs almost everywhere so the CSP can reach public pages,
    // which means the protected list moved into code. Losing an entry here is
    // an authentication hole, not a styling bug.
    for (const p of ["/dashboard", "/admin", "/fees", "/hr", "/operator", "/scan", "/manual", "/runbooks", "/account"]) {
      expect(mw).toContain(`"${p}"`);
    }
    expect(mw).toMatch(/isProtected\(pathname\)/);
  });

  it("matches a prefix only on a boundary", () => {
    // `/feesomething` must not be treated as `/fees`.
    expect(mw).toMatch(/pathname === p \|\| pathname\.startsWith\(`\$\{p\}\/`\)/);
  });
});

describe("what comes back through a proxy", () => {
  for (const [label, path] of [
    ["the authenticated proxy", "app/api/sms/[...path]/route.ts"],
    ["the public proxy", "app/api/public/[...path]/route.ts"],
  ] as const) {
    it(`${label} sandboxes its response`, () => {
      const src = stripComments(WEB(path));
      expect(src).toContain("default-src 'none'; sandbox");
      expect(src).toContain("X-Content-Type-Options");
    });
  }
});

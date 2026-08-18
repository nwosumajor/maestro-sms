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

  it("does not pretend to have a script policy", () => {
    // 'unsafe-inline' here would read as protection while allowing exactly the
    // thing script-src exists to stop. Better to have no script-src than a
    // decorative one — and the omission is deliberate, not forgotten.
    expect(config).not.toMatch(/script-src/);
  });

  it("keeps nosniff at the tier that serves the browser", () => {
    expect(config).toContain("X-Content-Type-Options");
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

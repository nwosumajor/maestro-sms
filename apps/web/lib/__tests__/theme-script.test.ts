// =============================================================================
// The hash that lets the theme script run
// =============================================================================
// The pre-paint theme bootstrap is inline and blocking, so a strict script-src
// cannot wave it through: 'self' does not cover inline code, and nothing Next
// already trusts injected it. It is admitted by HASH rather than a nonce,
// because a nonce would mean reading request headers in the root layout, which
// makes every route dynamic and costs the public pages their static generation.
//
// The failure this guards against is silent and was observed in a real browser
// before the hash existed: the script is blocked, nothing errors, and the only
// symptom is the app painting in the wrong theme. Editing the script without
// updating the hash reproduces exactly that — so the hash is recomputed here
// from the same string the page serves.
// =============================================================================

import { createHash } from "node:crypto";
import { THEME_SCRIPT, THEME_SCRIPT_CSP_HASH } from "../theme-script";

describe("the theme script's CSP hash", () => {
  it("matches the script actually served", () => {
    const digest = createHash("sha256").update(THEME_SCRIPT).digest("base64");
    expect(THEME_SCRIPT_CSP_HASH).toBe(`sha256-${digest}`);
  });

  it("is what the middleware admits", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const mw = readFileSync(join(__dirname, "../../middleware.ts"), "utf8");
    expect(mw).toContain("THEME_SCRIPT_CSP_HASH");
    // Belt and braces: the policy must carry a nonce AND the hash, or one of
    // the two things that need to run will not.
    expect(mw).toMatch(/script-src 'self' 'nonce-\$\{nonce\}' '\$\{THEME_SCRIPT_CSP_HASH\}'/);
  });

  it("still does the job it exists for", () => {
    // If this ever stops setting the class before paint, the hash is beside the
    // point — the flash is back.
    expect(THEME_SCRIPT).toContain('classList.toggle("dark"');
    expect(THEME_SCRIPT).toContain("window.__setTheme");
  });
});

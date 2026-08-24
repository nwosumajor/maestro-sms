// =============================================================================
// The platform org is not a school, on any public surface
// =============================================================================
// The operator's own organisation is a `school` row with `isPlatform = true`. It
// holds the super_admin, has no pupils, and must never appear where a customer
// school appears — a public directory, a careers board, an admissions intake, a
// branded sign-in page.
//
// An earlier sweep fixed four public slug resolvers. It missed the fifth:
// `GET /public/schools/:slug/branding`, which the LOGIN page calls to theme
// itself. So `/login?school=sms-platform` returned 200 and rendered
// "MAESTRO-SMS" in the slot where a school's name belongs — the operator's org
// presented as a tenant portal.
//
// Nothing secret leaked: the platform's name is on the marketing site. What was
// wrong is that it was addressable as a school at all, which is the invariant
// the other four were fixed for.
//
// This tests the RULE rather than the fifth instance, by finding every public
// slug lookup in the codebase and requiring each to exclude it. A sixth resolver
// added without the filter fails here rather than being found by hand later.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Bcrypt at cost factor 10 dominates this suite's runtime — that is the security
// parameter doing its job, not slow code, so the timeout moves rather than the
// cost. At the 5s default these pass alone and fail under full-suite
// parallelism, which teaches people to re-run a red suite instead of reading it.
jest.setTimeout(60_000);


const SRC = join(__dirname, "../../src");

function services(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) services(f, out);
    else if (f.endsWith(".service.ts") && !f.endsWith(".spec.ts")) out.push(f);
  }
  return out;
}

/** Controllers, to find which service methods sit behind a @Public route. */
function controllers(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) controllers(f, out);
    else if (f.endsWith(".controller.ts")) out.push(f);
  }
  return out;
}

describe("public routes that resolve a school by slug", () => {
  /** Every `@Public` handler that takes a `:slug` param. */
  const publicSlugHandlers: Array<{ file: string; route: string; handler: string }> = [];
  for (const file of controllers(SRC)) {
    const src = readFileSync(file, "utf8");
    // Bounded by the route's own DECORATOR RUN, not by a character count.
    //
    // This used to be `@Public()[\s\S]{0,200}?@Get("…:slug…")`, and adding one
    // more decorator to a route — a rate limiter, with the comment explaining
    // why — pushed it past 200 characters. The route silently stopped being
    // found and the count fell from three to two: a gate that quietly covers
    // less than it says, which is exactly the failure the count below exists to
    // catch. It caught it.
    const lines = src.split("\n");
    for (const [i, line] of lines.entries()) {
      const route = /^\s*@(?:Get|Post|Put)\("([^"]*:slug[^"]*)"\)\s*$/.exec(line);
      if (!route) continue;
      // Walk up through contiguous decorators and comments looking for @Public.
      let isPublic = false;
      for (let j = i - 1; j >= 0; j--) {
        const t = lines[j].trim();
        if (!(t.startsWith("@") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t === "")) break;
        if (t.startsWith("@Public(")) isPublic = true;
      }
      if (!isPublic) continue;
      // Then down to the handler name.
      const handler = lines.slice(i + 1, i + 8).map((l) => /^\s{2}(?:async\s+)?([a-zA-Z]+)\(/.exec(l)?.[1]).find(Boolean);
      if (handler) publicSlugHandlers.push({ file: file.slice(SRC.length + 1), route: route[1], handler });
    }
  }

  it("finds the public slug routes", () => {
    // If this ever drops to zero the suite below proves nothing.
    expect(publicSlugHandlers.length).toBeGreaterThanOrEqual(3);
  });

  it("every one of them names its route, for the record", () => {
    // Printed as data so the set is visible in the test output when it changes.
    const routes = publicSlugHandlers.map((h) => h.route).sort();
    expect(routes.length).toBe(publicSlugHandlers.length);
  });
});

describe("every school lookup BY SLUG excludes the platform org", () => {
  // A `where: { slug ... }` on the school table, in a service, is a slug
  // resolver. Each must carry `isPlatform: false` — or be listed below with a
  // reason, so an exemption is a decision rather than an omission.
  const EXEMPT: Record<string, string> = {
    // The operator console legitimately resolves its OWN org.
    "operator/operator-provisioning.service.ts": "provisioning resolves any school, operator-only",
  };

  const offenders: string[] = [];
  for (const file of services(SRC)) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(SRC.length + 1);
    if (rel in EXEMPT) continue;
    // Find `school.findFirst/findUnique({ where: { ... slug ... } })`.
    const re = /school\.(?:findFirst|findUnique)\(\{\s*where:\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(src))) {
      const where = m[1];
      if (!/\bslug\b/.test(where)) continue;
      if (/isPlatform:\s*false/.test(where)) continue;
      offenders.push(`${rel}: where {${where.trim().slice(0, 60)}}`);
    }
  }

  it("no public slug resolver can reach it", () => {
    expect(offenders).toEqual([]);
  });

  it("the branding resolver specifically — the one that was missed", () => {
    const src = readFileSync(join(SRC, "branding/branding.service.ts"), "utf8");
    // The status filter joined it later — a switched-off school does not present
    // a login page of its own — so match the two facts, not the exact literal.
    expect(src).toMatch(/where: \{ slug, isPlatform: false, status: "ACTIVE" \}/);
  });

  it("the resolvers that were already right stay right", () => {
    expect(readFileSync(join(SRC, "public/public.service.ts"), "utf8")).toMatch(/isPlatform: false/);
    expect(readFileSync(join(SRC, "hr/recruitment.service.ts"), "utf8")).toMatch(/isPlatform: false/);
  });
});

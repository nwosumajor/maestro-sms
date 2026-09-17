/**
 * A LINK THAT GOES TO "404: This page could not be found."
 *
 * `every-page-can-be-reached` asks the outbound question — is there a page
 * nothing links to. This is the INVERSE, and it is the one a user actually
 * meets: a button that exists, looks right, is permission-gated correctly, and
 * lands on Next's 404.
 *
 * Found on the worst possible button. `/attendance` renders the missing-register
 * board FIRST, deliberately, because it is the only time-critical thing on the
 * page — and its "take →" control pointed at `/classes/<id>`, which is not a
 * route: the class pages are `/info`, `/roster`, `/content` and `/analytics`.
 * So the single control that exists to get an outstanding register taken
 * answered "page not found". Two more sites had the same link — a pupil's
 * current class on their profile, and an unstaffed lesson on the timetable —
 * and `ClassAttendanceBoard` already carried a COMMENT warning that
 * `/classes/<id>` is not a route, which is a comment asserting a rule that three
 * other files were breaking.
 *
 * WHAT THIS CAN AND CANNOT SEE: it reads hrefs that are LITERAL in the source,
 * with `${…}` treated as one path segment. An href assembled from a variable
 * (`href={row.url}`) is invisible to it and always will be.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const WEB = path.join(__dirname, "../..");
const APP = path.join(WEB, "app");

/** Every routable page, as a segment pattern. `[id]` matches any one segment. */
function pages(dir = APP, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    // A route group `(x)` adds nothing to the URL.
    const seg = entry.startsWith("(") ? "" : `/${entry}`;
    const files = readdirSync(full);
    if (files.includes("page.tsx") || files.includes("route.ts")) out.push(`${prefix}${seg}` || "/");
    out.push(...pages(full, `${prefix}${seg}`));
  }
  return out;
}

function sources(dir = WEB, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, acc);
    else if (/\.tsx?$/.test(entry) && !/__tests__/.test(full)) acc.push(full);
  }
  return acc;
}

const ROUTES = [...new Set(pages())];

/** Does this href match a declared route? `[id]`/`[...x]` match a segment. */
function matches(href: string): boolean {
  const want = href.split("/").filter(Boolean);
  return ROUTES.some((r) => {
    const have = r.split("/").filter(Boolean);
    if (have.some((s) => s.startsWith("[..."))) {
      const fixed = have.slice(0, have.findIndex((s) => s.startsWith("[...")));
      return fixed.every((s, i) => s === want[i] || s.startsWith("["));
    }
    if (have.length !== want.length) return false;
    return have.every((s, i) => s.startsWith("[") || s === want[i]);
  });
}

/** Every literal href in the web, normalised: `${…}` becomes one segment. */
function literalHrefs(): { href: string; file: string }[] {
  const out: { href: string; file: string }[] = [];
  for (const file of sources()) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/href=(?:"(\/[^"]*)"|\{`(\/[^`]*)`\})/g)) {
      const raw = (m[1] ?? m[2]) as string;
      const href = raw
        .replace(/\$\{[^}]*\}/g, "x")   // an interpolated segment is a segment
        .split(/[?#]/)[0]                // query and hash are not the route
        .replace(/\/+$/, "");
      if (!href || href.startsWith("/api")) continue;
      out.push({ href, file: path.relative(WEB, file) });
    }
  }
  return out;
}

const HREFS = literalHrefs();

describe("every link goes somewhere", () => {
  it("read a believable number of routes and links", () => {
    // A walk that finds nothing produces no offenders and passes green.
    expect(ROUTES.length).toBeGreaterThan(50);
    expect(HREFS.length).toBeGreaterThan(80);
  });

  it("matches a route it should, and refuses one it should not", () => {
    // The matcher is the whole gate; an over-permissive one passes everything.
    expect(matches("/attendance")).toBe(true);
    expect(matches("/classes/x/info")).toBe(true);
    expect(matches("/classes/x")).toBe(false);
    expect(matches("/nowhere-at-all")).toBe(false);
  });

  it("points at no page that does not exist", () => {
    const broken = HREFS.filter((h) => !matches(h.href)).map((h) => `${h.href}  (${h.file})`);
    expect([...new Set(broken)]).toEqual([]);
  });
});

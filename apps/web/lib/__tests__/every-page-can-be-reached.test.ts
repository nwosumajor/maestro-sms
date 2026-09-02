/**
 * A page nobody can navigate to is not shipped.
 *
 * Written after a whole feature — the scholarship question library — was built,
 * tested, deployed, and styled as a MUTED CAPTION between two cards, so the
 * owner it was built for could not find it. The page was present and the nav
 * entry was right; what was missing was any visual claim to exist.
 *
 * This gate cannot see styling. What it CAN see is the harder failure: a page
 * with no nav entry and nothing anywhere linking to it. That is currently zero,
 * and this keeps it there.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const WEB = path.join(__dirname, "../..");
const APP = path.join(WEB, "app/(app)");

/** Every routable page under the signed-in shell. */
function pages(dir = APP, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    // A route group `(x)` adds nothing to the URL.
    const seg = entry.startsWith("(") ? "" : `/${entry}`;
    if (readdirSync(full).includes("page.tsx")) out.push(`${prefix}${seg}` || "/");
    out.push(...pages(full, `${prefix}${seg}`));
  }
  return out;
}

/** Every source file in the web app, for the inbound-link search. */
function sources(dir = WEB, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, acc);
    else if (/\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

const ALL_PAGES = [...new Set(pages())];
const SHELL = readFileSync(path.join(WEB, "components/shell/AppShell.tsx"), "utf8");
const NAV_HREFS = new Set([...SHELL.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]));
const FILES = sources();

describe("every page can be reached", () => {
  // The walk must find something, or every assertion below passes vacuously —
  // the blind-gate failure this repo gates against elsewhere.
  it("found the app's pages and sources", () => {
    expect(ALL_PAGES.length).toBeGreaterThan(80);
    expect(FILES.length).toBeGreaterThan(200);
  });

  it("has a page for every nav entry", () => {
    const dead = [...NAV_HREFS].filter((h) => !h.startsWith("http") && !ALL_PAGES.includes(h));
    expect(dead).toEqual([]);
  });

  // A page that is neither in the nav nor linked from anywhere is unreachable:
  // it exists, it renders, and no user can get to it.
  it("has a nav entry or an inbound link for every page", () => {
    const unreachable = ALL_PAGES.filter((p) => {
      if (NAV_HREFS.has(p)) return false;
      // A dynamic segment is reached by interpolation, which a literal search
      // cannot see — its PARENT is what has to be reachable.
      if (p.includes("[")) return false;
      const own = path.join(APP, p.slice(1), "page.tsx");
      return !FILES.some((f) => f !== own && readFileSync(f, "utf8").includes(`"${p}"`));
    });
    expect(unreachable).toEqual([]);
  });
});

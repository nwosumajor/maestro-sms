/**
 * AUDIT: an always-on PAGE that calls a module-GATED endpoint.
 *
 * The dashboard did this with `/analytics/overview` (ANALYTICS is a PREMIUM
 * add) and read the resulting 404 as a failed fetch, warning every STANDARD
 * school that its figures could not be loaded — permanently, about a module they
 * never bought. That is the shape being swept for here.
 *
 * A hit is not automatically a defect. It is a defect when the page has NO
 * guarantee of the module AND treats the resulting null as something other than
 * "not entitled" — a failure banner, or `?? []` rendering as "nothing recorded".
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { apiRoutes, API_SRC } from "../support/api-routes";

const WEB = join(__dirname, "../../../web");

/** endpoint -> the module it requires, if any. */
function moduleByRoute(): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of apiRoutes()) {
    const inBlock = /@RequireModule\(MODULES\.([A-Z_]+)\)/.exec(r.block)?.[1];
    const src = readFileSync(r.file, "utf8");
    const onClass = /@RequireModule\(MODULES\.([A-Z_]+)\)\s*\n@Controller/.exec(src)?.[1];
    const mod = inBlock ?? onClass;
    if (mod) out.set(`${r.method} ${r.path}`, mod);
  }
  return out;
}

/**
 * href -> module, from the AppShell nav. A page's REAL guarantee is usually
 * here rather than in the page body: /classes is gated on LMS by its nav entry,
 * so it calling /classes/mine is not a cross-module call at all. Without this
 * the audit reports every page against its own module and drowns the findings.
 */
function navModules(): Array<[string, string]> {
  const shell = readFileSync(join(WEB, "components/shell/AppShell.tsx"), "utf8");
  const out: Array<[string, string]> = [];
  for (const m of shell.matchAll(/href:\s*"([^"]+)"[\s\S]{0,400}?module:\s*(?:MODULES\.([A-Z_]+)|"([a-z_]+)")/g)) {
    out.push([m[1], (m[2] ?? m[3] ?? "").toUpperCase()]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

function pages(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) pages(p, acc);
    else if (e === "page.tsx") acc.push(p);
  }
  return acc;
}

/** `/classes/${id}/x` -> `/classes/:p/x`, so it matches a route pattern. */
const normalise = (s: string) =>
  s.replace(/\$\{[^}]*\}/g, ":p").replace(/\?.*$/, "").replace(/\/$/, "");

describe("always-on pages calling gated modules", () => {
  const byRoute = moduleByRoute();
  const nav = navModules();
  const files = pages(join(WEB, "app/(app)"));

  it("found the API surface, the pages and the nav", () => {
    expect(byRoute.size).toBeGreaterThan(50);
    expect(files.length).toBeGreaterThan(30);
    expect(nav.length).toBeGreaterThan(10);
  });

  // Everything in the entry tier is present on EVERY paying plan, so a call
  // into one of these can only 404 under a deliberate operator override. The
  // actionable set is calls into modules a paying school may genuinely not have.
  const ENTRY_TIER = new Set([
    "LMS", "GRADEBOOK", "ATTENDANCE", "TIMETABLE", "MESSAGING",
    "CALENDAR", "SIS", "LIBRARY", "FEES", "DOCUMENTS",
  ]);

  it("reports every always-on page reaching into a gated module", () => {
    const rows: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const rel = f.replace(`${WEB}/`, "");
      // The page's own route, e.g. app/(app)/fees/[id]/page.tsx -> /fees/:p
      const route =
        "/" +
        rel.replace("app/(app)/", "").replace(/\/page\.tsx$/, "").replace(/\[[^\]]+\]/g, ":p");
      const navMod = nav.find(([href]) => route === href || route.startsWith(`${href}/`))?.[1];
      // What this page guarantees for itself.
      // THE GUARD MUST BE ON THE CALL, NOT MERELY IN THE FILE.
      //
      // A file-level scan sees `MODULES.INTEGRITY` in the "not on your plan"
      // COPY and calls the page guarded even after the fetch is ungated —
      // mutation-tested, and it passed both times. The question is whether THIS
      // call is conditional, so only the text immediately before it counts.
      const guardedCall = (idx: number) =>
        /(?:\bhas[A-Z]\w*|mod\()\s*(?:&&|\?)[^;]{0,80}$/.test(src.slice(Math.max(0, idx - 200), idx));

      for (const call of src.matchAll(/api(?:Get|Post)<[^>]*>\(\s*[`"]([^`"]+)[`"]/g)) {
        const path = normalise(call[1]);
        if (guardedCall(call.index ?? 0)) continue;
        const hit = [...byRoute.entries()].find(([k]) => {
          const [, rp] = k.split(" ");
          if (!k.startsWith("GET ")) return false;
          const a = rp.split("/"), b = path.split("/");
          return a.length === b.length && a.every((seg, i) => seg.startsWith(":") || seg === b[i]);
        });
        if (!hit) continue;
        const mod = hit[1];
        if (mod === navMod) continue;
        if (ENTRY_TIER.has(mod)) continue;
        rows.push(`${rel}\n    ${path}  requires ${mod}`);
      }
    }
    // AN EMPTY LIST IS THE POINT. Two were found by this audit and both are
    // fixed; a third would be the same defect again, so it fails rather than
    // prints. A page that legitimately needs a gated endpoint proves it by
    // calling `mod()` before fetching — which is the fix, not an exemption.
    expect([...new Set(rows)]).toEqual([]);
  });

  it("keeps the two the audit found gated, so they cannot regress", () => {
    // Both read a module OUTSIDE the entry tier from a page reachable without
    // it, and both then rendered a FAILURE where the truth was "not on your
    // plan": the dashboard's amber "Reload to try again", and admissions' RED
    // "applicants are waiting on a decision".
    const dash = readFileSync(join(WEB, "app/(app)/dashboard/page.tsx"), "utf8");
    expect(dash).toMatch(/const hasAnalytics = mod\(MODULES\.ANALYTICS\)/);
    const adm = readFileSync(join(WEB, "app/(app)/admin/admissions/page.tsx"), "utf8");
    expect(adm).toMatch(/const hasAdmissions = .*MODULES\.ADMISSIONS/);
    expect(adm).toMatch(/Admissions is not part of your plan/);
    // And the tile that led there is gated too — the page is only reached
    // because /admin offered it on permission alone.
    const admin = readFileSync(join(WEB, "app/(app)/admin/page.tsx"), "utf8");
    expect(admin).toMatch(/module: MODULES\.ADMISSIONS/);
  });
});

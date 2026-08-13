// =============================================================================
// A platform page the platform owner cannot see
// =============================================================================
// The operator console's nav is filtered twice for a super_admin: by permission,
// like every other role, and then by PLATFORM_OWNER_NAV — an allow-list that
// exists because a platform owner belongs to no customer school, so tenant pages
// (Attendance, Fees, Classes) would be links to nothing.
//
// /operator/jobs was added with a nav entry, the right permission and a working
// page, and was never added to that allow-list. So the link never rendered for
// the one role that runs the platform's sweeps, while rendering perfectly well
// when the URL was typed by hand. Nothing errored: the page was reachable, the
// permission was correct, and the sidebar simply omitted it.
//
// The failure is invisible from either end. Reading the NAV array, the entry is
// there. Reading the allow-list, nothing says one is missing. Only the two read
// together tell you — which is what this test does.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../components/shell/AppShell.tsx"), "utf8");

/** Nav keys declared in the NAV array — bounded to it, since the section-label
 *  array below uses the same `key:` shape and would otherwise be counted. */
function navKeys(): string[] {
  const start = SRC.indexOf("const NAV: {");
  const end = SRC.indexOf("const NAV_GROUPS", start);
  return [...SRC.slice(start, end).matchAll(/\{ key: "([a-z]+)",/g)].map((m) => m[1]);
}

function platformOwnerAllowList(): Set<string> {
  const start = SRC.indexOf("const PLATFORM_OWNER_NAV");
  const block = SRC.slice(start, SRC.indexOf("]);", start));
  return new Set([...block.matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
}

/** key -> group, from the map that files each nav entry into a sidebar group. */
function sections(): Record<string, string> {
  const start = SRC.indexOf("const NAV_GROUP: Record<NavKey, string> = {");
  const block = SRC.slice(start, SRC.indexOf("};", start));
  return Object.fromEntries([...block.matchAll(/([a-zA-Z]+): "([a-z]+)"/g)].map((m) => [m[1], m[2]]));
}

describe("the platform owner's sidebar", () => {
  const keys = navKeys();
  const allow = platformOwnerAllowList();

  it("offers every operator page", () => {
    // The concrete rule: an `/operator/*` page is a PLATFORM surface by
    // definition, so a platform owner must be able to reach it from the nav. If
    // a new one is ever added without this entry it is invisible to them, which
    // is exactly how Background jobs shipped hidden.
    const operatorKeys = keys.filter((k) => k.startsWith("operator"));
    expect(operatorKeys.length).toBeGreaterThan(5);
    expect(operatorKeys.filter((k) => !allow.has(k))).toEqual([]);
  });

  it("includes Background jobs specifically", () => {
    // Named, because this is the one that was missing and the sweeps it runs —
    // dunning, reconciliation, mobile-money recovery — are the platform's money.
    expect(allow.has("operatorjobs")).toBe(true);
  });

  it("does not allow-list a key that no longer exists in the nav", () => {
    // The opposite drift: a stale entry here is harmless but means the list has
    // stopped describing the nav, and the check above stops being meaningful.
    const declared = new Set(keys);
    expect([...allow].filter((k) => !declared.has(k))).toEqual([]);
  });

  it("still excludes tenant-operational pages", () => {
    // The allow-list earns its place: a platform owner belongs to no customer
    // school, so these would be links to an empty tenant. If this ever passes
    // trivially, someone has widened the list to everything.
    for (const tenantPage of ["attendance", "fees", "classes", "timetable"]) {
      if (navKeys().includes(tenantPage)) expect(allow.has(tenantPage)).toBe(false);
    }
  });
});

describe("every nav entry is filed under a section", () => {
  it("so none is dropped from the grouped sidebar", () => {
    // The second way a link can vanish: rendered nav is grouped by section, so a
    // key missing from the map has no group to appear in.
    const map = sections();
    const missing = navKeys().filter((k) => !map[k]);
    expect(missing).toEqual([]);
  });
});

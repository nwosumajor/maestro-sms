// =============================================================================
// A tile that bounces you back
// =============================================================================
// The dashboard's KPI tiles are links. Most were gated on a permission —
// can("fee.read"), can("class.read"), can("workflow.read") — but two were gated
// on the FIGURE being present instead:
//
//   if (overview?.operations?.students != null)  -> href "/students"
//   if (att != null)                             -> href "/attendance"
//
// The analytics endpoint hands those figures to anyone with school-wide scope,
// which is a wider set than the people allowed to open the pages behind them. So
// a bursar and a board member saw "Students 901 — on the register", clicked, and
// landed back on the dashboard. Measured across seventeen roles and 131 links on
// the page: exactly two dead, both this tile.
//
// The fix keeps the FIGURE and drops the LINK. Those two questions are separate:
// the roll is legitimately a bursar's business — their invoices are raised
// against it — while the student records behind it are not. Removing the tile
// would have hidden a number the role is entitled to; keeping the link made a
// promise the next page refuses.
//
// Nothing here can be caught by the route smoke, which visits pages by URL and
// so never asks whether the thing that OFFERS a page agrees with the thing that
// GUARDS it. That question needs the two read together, which is what this does.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../app/(app)/dashboard/page.tsx"), "utf8");

/** The KPI tile block: everything pushed onto `stats`. */
const TILES = SRC.slice(SRC.indexOf("const stats:"), SRC.indexOf("const kpis ="));

describe("every KPI tile link is gated on the destination's own permission", () => {
  it("routes every href through linkIf", () => {
    // The single chokepoint. A tile added with a bare `href: "/x"` skips the
    // permission question entirely, which is exactly how these two shipped.
    const bareHrefs = [...TILES.matchAll(/href: "(\/[a-z/]+)"/g)].map((m) => m[1]);
    expect(bareHrefs).toEqual([]);
  });

  it("has a linkIf for every tile that offers a destination", () => {
    const links = [...TILES.matchAll(/href: linkIf\("([a-z.]+)", "([a-z/]+)"\)/g)];
    expect(links.length).toBeGreaterThanOrEqual(6);
    // Each pairing must be the permission that page actually requires. These are
    // the ones a wrong pairing would silently break.
    const byHref = Object.fromEntries(links.map((m) => [m[2], m[1]]));
    expect(byHref["/students"]).toBe("student.profile.read");
    expect(byHref["/attendance"]).toBe("attendance.read");
    expect(byHref["/fees"]).toBe("fee.read");
    expect(byHref["/classes"]).toBe("class.read");
    expect(byHref["/gradebook"]).toBe("grade.read");
    expect(byHref["/workflows"]).toBe("workflow.read");
  });

  it("linkIf returns undefined rather than a link the viewer cannot follow", () => {
    expect(SRC).toMatch(/const linkIf = \(perm: Permission, href: string\) => \(can\(perm\) \? href : undefined\)/);
  });
});

describe("the tile still shows its figure when there is nowhere to go", () => {
  it("Stat takes an OPTIONAL href", () => {
    // Not `href: string`. The bursar keeps the roll count; they just cannot
    // click through to the records.
    expect(SRC).toMatch(/function Stat\(\{ label, value, sub, href \}: \{ label: string; value: string; sub\?: string; href\?: string \}\)/);
  });

  it("renders a plain tile, not a Link, when href is absent", () => {
    expect(SRC).toMatch(/return href \? \(/);
    expect(SRC).toMatch(/<div className=\{className\}>\{inner\}<\/div>/);
  });

  it("hides the hover arrow when the tile is not a link", () => {
    // A tile that looks clickable and is not is its own small lie.
    expect(SRC).toMatch(/\{href && \(\s*<span aria-hidden/);
  });
});

describe("quick actions were already gated, and must stay that way", () => {
  const ACTIONS = SRC.slice(SRC.indexOf("const actions:"), SRC.indexOf("const kpis =") > SRC.indexOf("const actions:") ? SRC.length : SRC.length);
  it("every action carries a show: predicate", () => {
    // These were correct all along — each one is `show: can(...)`. Pinned so the
    // tiles' defect does not migrate here.
    const actionBlock = SRC.slice(SRC.indexOf("const actions:"), SRC.indexOf("].filter("));
    const entries = actionBlock.match(/\{ icon: /g) ?? [];
    const shows = actionBlock.match(/show: /g) ?? [];
    expect(entries.length).toBeGreaterThan(5);
    expect(shows.length).toBe(entries.length);
    expect(ACTIONS.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// THE GATE: every endpoint has a decided answer to "how is this reached?"
// =============================================================================
// Certainty about the API surface cannot come from detection. Paths in the web
// are built at runtime — `postSms(`payments/${id}/${action}`)` — so no static
// analysis can prove which route that reaches. Four separate attempts at a
// detector produced four different numbers (418, 269, 232, 208), each wrong in a
// different way, and every correction found a real extraction bug: nested
// generics truncating a regex, query strings failing to normalise, two helpers
// nobody had enumerated.
//
// So this does not detect. It DECLARES.
//
// `api-surface.registry.json` records, for every route the API serves, one of:
//
//   ui      — reachable from the product. The note says how: a literal path in
//             apps/web, or the runtime-built shape that justifies it.
//   system  — reachable by design without a screen: a gateway webhook, a
//             liveness probe, a manual trigger for a scheduled job. The note
//             says which, because "no UI" and "no UI YET" look identical in
//             source and are opposites in meaning.
//   gap     — known to be unreachable, deliberately tracked. This is the column
//             that would have caught the year archive: an endpoint built for a
//             principal that no principal could reach.
//
// The registry is seeded by test/surface/generate-registry.ts, which
// auto-classifies only what it can PROVE and leaves the rest UNCLASSIFIED. A
// human decides those once. This gate then keeps the answer true: a new endpoint
// fails the build until someone says how it is reached.
//
// That is where the certainty actually comes from — someone having looked at
// each one — and this is what stops it decaying.
// =============================================================================

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractRoutes } from "./extract";

const API_SRC = join(__dirname, "..", "..", "src");
const REGISTRY_PATH = join(__dirname, "api-surface.registry.json");

type Kind = "ui" | "system" | "gap" | "UNCLASSIFIED";
const registry: { routes: Record<string, { kind: Kind; note: string }> } = JSON.parse(
  readFileSync(REGISTRY_PATH, "utf8"),
);
const routes = extractRoutes(API_SRC);

/**
 * How many routes may still be awaiting a human decision.
 *
 * A RATCHET, not a target. It was 131 when this gate shipped, so it could land
 * before the review was done without the review quietly never happening.
 *
 * IT IS NOW ZERO: every route has a decision. Raising it again would mean
 * shipping an endpoint nobody could say how to reach, which is the exact thing
 * this file exists to prevent.
 */
const UNCLASSIFIED_BUDGET = 0;

/** Source files a registry note claims a route is reached from. */
function claimedFiles(note: string): string[] {
  return note.match(/(?:components|app|lib)\/[A-Za-z0-9_\-./[\]()]+\.tsx?/g) ?? [];
}

describe("every API route has a decided answer to 'how is this reached?'", () => {
  // A NOTE THAT NAMES A FILE MUST NAME ONE THAT EXISTS.
  //
  // This registry deliberately DECLARES rather than detects, because paths are
  // built at runtime and no static analysis can follow them. That is right, and
  // it makes each note an unverified claim — so the part of a claim that CAN be
  // checked should be. 163 notes name a source file; one named
  // `components/careers/CareersApply.tsx`, which has never existed (the public
  // job application is posted from `components/public/CareersBoard.tsx`).
  //
  // Worth more than tidiness: a stale note is how a dead route hides. The
  // gradebook's `POST /submissions/:id/grade` was recorded as "reached from
  // GradingConsole.tsx" while another controller shadowed it on the same URL —
  // a route that could not work, recorded as reachable, pointing at a screen
  // that never called it.
  // // GOTCHA while writing this: the corrected note first EXPLAINED the fix by
  // naming the dead file, and the gate flagged its own explanation — the same
  // trap `money-is-not-divided-by-a-hundred` strips comments for. A note says
  // where a route IS reached from; a filename that no longer exists does not
  // belong in it, however well meant.
  it("names only source files that exist", () => {
    const web = join(__dirname, "..", "..", "..", "web");
    const missing: string[] = [];
    let named = 0;
    for (const [key, entry] of Object.entries(registry.routes)) {
      for (const f of claimedFiles(entry.note ?? "")) {
        named += 1;
        if (!existsSync(join(web, f))) missing.push(`${key} -> ${f}`);
      }
    }
    // A scan that finds no claims would pass covering nothing.
    expect(named).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });

  it("has a registry entry for every route the API serves", () => {
    // A NEW endpoint fails here. That is the whole mechanism: you cannot add a
    // route without saying how a human reaches it, or why none can.
    const missing = routes.filter((r) => !registry.routes[r.key]).map((r) => `${r.key}   (${r.file})`);
    expect(missing).toEqual([]);
  });

  it("has no registry entry for a route that no longer exists", () => {
    // Stale entries are how a registry stops describing reality. A deleted
    // endpoint whose entry lingers makes the next reader trust a stale note.
    const live = new Set(routes.map((r) => r.key));
    const stale = Object.keys(registry.routes).filter((k) => !live.has(k));
    expect(stale).toEqual([]);
  });

  it("records a REASON for every route with no UI", () => {
    // "system" without a reason is indistinguishable from "we forgot". The note
    // is the entire value of the classification.
    const unreasoned = Object.entries(registry.routes)
      .filter(([, v]) => (v.kind === "system" || v.kind === "gap") && !v.note.trim())
      .map(([k]) => k);
    expect(unreasoned).toEqual([]);
  });

  it("keeps the unreviewed backlog shrinking, never growing", () => {
    const unclassified = Object.entries(registry.routes).filter(([, v]) => v.kind === "UNCLASSIFIED");
    // Named, so the failure tells you what to review rather than only that you must.
    if (unclassified.length > UNCLASSIFIED_BUDGET) {
      throw new Error(
        `${unclassified.length} routes are unclassified, budget is ${UNCLASSIFIED_BUDGET}.\n` +
          `Classify them in api-surface.registry.json and LOWER the budget:\n` +
          unclassified.slice(0, 20).map(([k]) => `  ${k}`).join("\n"),
      );
    }
    expect(unclassified.length).toBeLessThanOrEqual(UNCLASSIFIED_BUDGET);
  });

  it("surfaces known gaps rather than letting them hide", () => {
    // A `gap` is not a failure — it is the honest state of an endpoint nobody can
    // reach yet. Printed so it stays visible; the year archive sat in exactly
    // this state for a whole PR and nothing said so.
    const gaps = Object.entries(registry.routes).filter(([, v]) => v.kind === "gap");
    if (gaps.length) {
      // eslint-disable-next-line no-console -- reason: the point is visibility
      console.warn(`\n  ${gaps.length} endpoint(s) have NO way to reach them:\n` +
        gaps.map(([k, v]) => `    ${k} — ${v.note}`).join("\n"));
    }
    expect(Array.isArray(gaps)).toBe(true);
  });
});

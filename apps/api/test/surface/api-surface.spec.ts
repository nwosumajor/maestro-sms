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

import { readFileSync } from "node:fs";
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
 * A RATCHET, not a target. It exists so this gate could be committed before all
 * 753 were reviewed, without the review quietly never happening — every batch
 * classified lowers it, and it can never rise. Setting it to 0 is the goal and
 * the point at which the surface is fully known.
 */
const UNCLASSIFIED_BUDGET = 131;

describe("every API route has a decided answer to 'how is this reached?'", () => {
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

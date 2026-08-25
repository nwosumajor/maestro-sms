// =============================================================================
// Two handlers, one URL, and the second one is dead
// =============================================================================
// `GradebookController` and `LmsContentController` both declare
// `@Controller()` with no prefix, and both declared `POST submissions/:id/grade`.
// Nest maps both; Express answers with the FIRST, so the gradebook's own
// grading endpoint was unreachable dead code — and the two take DIFFERENT
// bodies and DIFFERENT permissions, so the loser's callers do not get a 404
// they can diagnose. They get somebody else's error.
//
// Measured live: a teacher holding `grade.write` posted the gradebook's own
// documented body and got `400 {"fieldErrors":{"grade":["Required"]}}` — an
// error about a field they never sent. A principal without `content.write` got
// a bare 403 for a permission the endpoint they meant does not require. And
// `grade.status` (DRAFT | PUBLISHED) could not be set through the API at all.
//
// A parameter's NAME does not distinguish a route: `:submissionId` and `:id`
// are the same URL. That is exactly what made this invisible to a reader — the
// two lines do not look alike — and it is why this gate normalises them, the
// same way the shared route extractor already does for every other surface
// gate.
// =============================================================================

import { apiRoutes } from "../support/api-routes";
import { normalisePath } from "./extract";

/**
 * Deliberate duplicates, each with the reason.
 *
 * Empty. A second handler on one URL is not a thing to allow with a note — it
 * is a handler that never runs — so the list exists to make that argument
 * explicit if anyone ever wants to make it.
 */
const ALLOWED: Record<string, string> = {};

describe("every declared route answers on its own URL", () => {
  const routes = apiRoutes();

  it("found the surface at all — the scan has not silently broken", () => {
    // A walk that finds nothing produces no duplicates and passes covering
    // nothing.
    expect(routes.length).toBeGreaterThan(500);
  });

  it("no two handlers are mapped to the same method and path", () => {
    const seen = new Map<string, string[]>();
    for (const r of routes) {
      // NORMALISED, and this is the whole gate.
      //
      // `apiRoutes` keys on the path AS WRITTEN, so `:submissionId` and `:id`
      // are different strings and the collision this file exists for did not
      // show up in it at all — my first version passed while the two routes
      // were still on one URL, caught only by putting the defect back. A
      // parameter's NAME is not part of the URL, and that is exactly what made
      // the clash invisible to a reader: the two lines do not look alike.
      const key = `${r.method} ${normalisePath(r.path)}`;
      seen.set(key, [...(seen.get(key) ?? []), r.file.split("/src/")[1] ?? r.file]);
    }
    const clashes = [...seen.entries()]
      // A file legitimately declares several methods on one path; two DIFFERENT
      // files declaring the same method+path is the shadowing case.
      .filter(([key, where]) => new Set(where).size > 1 && !(key in ALLOWED))
      .map(([key, where]) => `${key}  declared in ${where.join("  AND  ")}`);
    expect(clashes).toEqual([]);
  });

  it("gives every allowed duplicate a reason, and none that is now unused", () => {
    const live = new Set(routes.map((r) => `${r.method} ${normalisePath(r.path)}`));
    for (const [key, why] of Object.entries(ALLOWED)) {
      expect([key, why.length > 60]).toEqual([key, true]);
      // A dangling entry is a hole waiting for the URL to be reused.
      expect([key, live.has(key)]).toEqual([key, true]);
    }
  });
});

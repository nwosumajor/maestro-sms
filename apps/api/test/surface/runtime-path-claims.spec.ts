// =============================================================================
// The registry entry that vouched for a screen nobody had written
// =============================================================================
// `api-surface.registry.json` forces a decided answer to "how is this endpoint
// reached?", and 563 of its 817 routes are backed by a literal path found in
// apps/web — a strong claim. Fifty-two rest on a weaker one:
//
//     "reached via a runtime-built path (web builds \"/classes/:p\")"
//
// That is a PREFIX. The web building "/classes/:id/enrollments" says nothing
// about "/classes/:id/enrollments/bulk", and the heuristic marked both `ui`.
// Checking each tail against apps/web found nine that appear nowhere, of which
// seven were genuinely unreachable — including a four-endpoint pupil-profile
// review chain (completion → submit → supervisor-review → approve) with no
// screen at all, and the teacher's own cover-duty list, whose absence meant a
// teacher was notified of a duty they could never look up again.
//
// Two of the nine were FALSE ALARMS, which is why this test asserts what it does
// rather than banning the note outright: `/autosave` is reached through a
// composed helper, `endpoint(integrity, "autosave")`, and a tail search cannot
// see it. A rule that forbade composed paths would be wrong about working code.
//
// So the automated rule is narrow: a route resting on a prefix must not claim
// `ui` when its distinguishing segment appears nowhere in apps/web. Measured,
// that catches one of the four gaps found by hand and clears the false alarm —
// a floor, not a proof. The NAMED assertions below are what hold the line, and
// the convention worth copying is the one the strongest entries already use:
// the note names the file that reaches the route.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REGISTRY = JSON.parse(
  readFileSync(join(__dirname, "api-surface.registry.json"), "utf8"),
) as { routes: Record<string, { kind: string; note: string }> };

const WEB = join(__dirname, "../../../web");
function webSources(): string {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (/node_modules|\.next/.test(p)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry)) out.push(readFileSync(p, "utf8"));
    }
  })(WEB);
  return out.join("\n");
}
const web = webSources();

/** The segments after the LAST path parameter — what a prefix cannot vouch for. */
function tailOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const lastParam = parts.map((p, i) => (p.startsWith(":") ? i : -1)).filter((i) => i >= 0).pop();
  return lastParam === undefined ? [] : parts.slice(lastParam + 1);
}

describe("a prefix is not evidence of a screen", () => {
  it("every ui route resting on a runtime-built path has its tail somewhere in the web", () => {
    const offenders: string[] = [];
    for (const [route, v] of Object.entries(REGISTRY.routes)) {
      if (v.kind !== "ui" || !/runtime-built path/.test(v.note)) continue;
      const tail = tailOf(route.split(" ")[1]);
      if (tail.length === 0) continue; // ends in a parameter — the prefix IS the route
      // The LAST segment is the distinguishing one. A path may be composed from
      // pieces (`endpoint(integrity, "autosave")`), so this looks for the bare
      // token anywhere rather than for a slash-joined path.
      //
      // WHAT THIS CAN AND CANNOT DO, measured rather than assumed. Of the four
      // real gaps found by hand, it catches "supervisor-review" (0 occurrences)
      // and misses "bulk" (23), "completion" (11) and "mine" (57) — common words
      // that appear all over a web app for unrelated reasons. It also correctly
      // clears "autosave" (9), which is reached and must not be flagged.
      //
      // So this is a floor, not a proof, and the named assertions below are what
      // actually hold the line. Said plainly here because a check that looks
      // thorough and is not is the same fault this file exists to fix.
      const distinguishing = tail[tail.length - 1];
      if (!web.includes(distinguishing)) {
        offenders.push(`${route} — "${distinguishing}" appears nowhere in apps/web`);
      }
    }
    // A failure means either the screen was never written (mark it `gap` and say
    // so) or it exists and the note should name the file, like the strongest
    // entries already do.
    expect(offenders).toEqual([]);
  });

  it("the pupil-profile chain is UI now, and every note names its file", () => {
    // These four were `gap` when this test was written — a four-endpoint chain
    // with no screen. The screens exist now, so the assertion moves UP rather
    // than away: `ui` is only accepted with a named file, which is the evidence
    // a prefix could never give. Re-marking one `ui` with a hand-wave note fails
    // here, which is the point.
    for (const route of [
      "GET /students/:p/profile/completion",
      "POST /students/:p/profile/submit",
      "POST /students/:p/profile/supervisor-review",
      "POST /students/:p/profile/approve",
      "GET /students/profile-reviews",
    ]) {
      const entry = REGISTRY.routes[route];
      expect(entry?.kind).toBe("ui");
      expect(entry?.note).toMatch(/components\/sis\/ProfileReview(Chain|Queue)\.tsx/);
    }
  });

  it("the bulk class endpoints are UI now, each naming its file", () => {
    // These were the last two `gap`s: endpoints built and never wired, so the
    // admin enrolled a class one pupil at a time. Like the profile chain, the
    // assertion moves UP rather than away — `ui` only counts with a named file.
    for (const [route, file] of [
      ["POST /classes/:p/enrollments/bulk", /BulkEnrol\.tsx/],
      ["POST /classes/:p/subjects/bulk", /BulkClassSubjects\.tsx/],
    ] as const) {
      expect(REGISTRY.routes[route]?.kind).toBe("ui");
      expect(REGISTRY.routes[route]?.note).toMatch(file);
    }
  });

  it("every route has a decided kind — nothing unclassified", () => {
    // The registry is currently gap-free, which is only worth anything if the
    // OTHER kinds are still real answers. A route with no kind at all is the
    // thing this file exists to prevent.
    const undecided = Object.entries(REGISTRY.routes)
      .filter(([, v]) => !["ui", "system", "gap", "public", "internal"].includes(v.kind))
      .map(([k]) => k);
    expect(undecided).toEqual([]);
  });

  it("the cover-duty list is UI now, and its note names the file", () => {
    const entry = REGISTRY.routes["GET /timetable/cover/mine"];
    expect(entry?.kind).toBe("ui");
    expect(entry?.note).toMatch(/MyCoverDuties\.tsx/);
  });

  it("the strongest notes name a file — the shape to copy", () => {
    // Not enforced for every route (563 rest on a literal-path match, which is
    // evidence enough); this pins that the convention exists and is used.
    const named = Object.values(REGISTRY.routes).filter((v) => /\.tsx|\.ts\b/.test(v.note));
    expect(named.length).toBeGreaterThan(5);
  });
});

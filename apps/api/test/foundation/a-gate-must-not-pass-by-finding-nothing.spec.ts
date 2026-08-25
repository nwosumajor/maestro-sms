// =============================================================================
// The failure every source-scanning gate shares
// =============================================================================
// This repo leans hard on gates that walk the source tree, derive a set of
// offenders and assert it is empty. They have caught a great deal. They also
// share one failure mode, and it is silent: **a walk that finds no files
// produces no offenders, and the gate passes with a green tick while covering
// nothing.** A moved directory, a changed extension, a renamed root — any of
// them turns a guard into decoration without a single red test.
//
// Not theoretical. Demonstrated on this repo by pointing `csv-injection`'s walk
// at a directory holding no `.ts` files: every assertion passed, and the
// spreadsheet-formula guard could have been deleted from every export in the
// product without that gate noticing.
//
// It had already happened twice for real, in different disguises:
//   * `platform-org-not-a-school` matched `@Public()` within 200 characters of a
//     route. Adding one decorator pushed a route past the window; the covered
//     count fell from three to two and nothing went red — its own magnitude
//     assertion is what caught it.
//   * `every-mutation-leaves-a-trail` resolved service methods by NAME across
//     every file, so `this.db.runAsTenant(...)` matched a `runAsTenant` that
//     happened to audit. The gate went green for the wrong reason: deleting the
//     audit call it was written for did not fail it.
//
// So the rule: a test that WALKS and asserts an EMPTY list must also assert it
// SCANNED something. The magnitude is the only thing that distinguishes "clean"
// from "blind", and it costs one line.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [join(__dirname, "../../test"), join(__dirname, "../../../web/lib/__tests__")];

/**
 * Gates whose empty-list assertion is over a set that is NOT derived from a
 * walk — so an empty result means "nothing matched", not "nothing was read".
 */
const NOT_A_WALK: Record<string, string> = {};

function specs(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) specs(f, out);
    else if (/\.(spec|test)\.ts$/.test(f)) out.push(f);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => specs(r));

describe("every test that walks the source tree", () => {
  it("found the tests at all — this file is not exempt from its own rule", () => {
    expect(FILES.length).toBeGreaterThan(200);
  });

  it("asserts it scanned something, so it cannot pass by finding nothing", () => {
    const blind: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      const rel = file.split("/test/")[1] ?? file.split("__tests__/")[1] ?? file;
      if (NOT_A_WALK[rel]) continue;
      // A gate: it walks a directory AND asserts an empty offender list.
      const walks = /readdirSync\s*\(/.test(src);
      const assertsEmpty = /expect\(\s*\w+\s*\)\.toEqual\(\[\]\)/.test(src);
      if (!walks || !assertsEmpty) continue;
      // The guard: SOME assertion that a count is above a floor.
      const hasMagnitude = /toBeGreaterThan(OrEqual)?\(\s*\d+\s*\)/.test(src);
      if (!hasMagnitude) blind.push(rel);
    }
    expect(blind).toEqual([]);
  });

  it("is a rule with real subjects — the detector has not stopped matching", () => {
    // Without this, the check above passes the day the regexes stop recognising
    // a gate at all: precisely the blindness it exists to forbid, in itself.
    const gates = FILES.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /readdirSync\s*\(/.test(src) && /expect\(\s*\w+\s*\)\.toEqual\(\[\]\)/.test(src);
    });
    expect(gates.length).toBeGreaterThan(20);
  });
});

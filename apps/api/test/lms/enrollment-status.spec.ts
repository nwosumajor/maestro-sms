// =============================================================================
// A pupil who has left is not enrolled
// =============================================================================
// Enrolment gained a `status` when promotion and transfers were built —
// ACTIVE / TRANSFERRED / WITHDRAWN / PROMOTED / GRADUATED. Most readers were
// updated to filter on ACTIVE. Six were not, and each one quietly treats a
// departed pupil as still present:
//
//   * today's REGISTER listed them for a teacher to mark;
//   * the daily overview counted them in the EXPECTED total, so a fully-marked
//     class read "28 of 32" and looked like the teacher forgot four children;
//   * a bulk ID-card / certificate run would print for them;
//   * discipline listed them as a classmate a report could be filed against.
//
// Nothing is wrong in the live data today — every enrolment there is ACTIVE —
// which is exactly why this went unnoticed. It bites the first time a school
// withdraws or transfers anyone, and it bites on the most-used screen in the
// product.
//
// This is the "adding an enum member compiles and does nothing" shape: the
// writer was updated, the readers were not, and no test could see the gap
// because both halves are individually correct.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

/**
 * SCOPED TO ROSTERS, deliberately.
 *
 * Two very different questions get asked of this table, and only one of them
 * has an obvious answer:
 *
 *   "WHO IS IN THIS CLASS?"  — a register, a headcount, a print run, a list of
 *     classmates. A pupil who has left is always wrong here, no judgement
 *     needed. That is what this guard covers: a read keyed on classId that
 *     pulls studentId, or a per-class count.
 *
 *   "CAN THIS PERSON SEE THAT?" — access scoping, and a genuine policy
 *     question rather than a bug. Should a withdrawn pupil still reach last
 *     term's report card? Their own data export? Arguably yes. Roughly forty
 *     such reads exist and sweeping them all would be a large, unconsidered
 *     change to access control, so they are deliberately out of scope here.
 *
 * A guard that fails on things which are not defects gets suppressed, and then
 * it protects nothing.
 */
const ROSTER_SHAPE = /classId[\s\S]{0,120}?studentId|by: \["classId"\]/;

describe("enrolment readers filter on status", () => {
  const files = sourceFiles(join(__dirname, "../../src"));

  it("scanned something — this gate can otherwise pass by finding nothing", () => {
    // THE FAILURE EVERY SOURCE-SCANNING GATE SHARES. The check above asserts an
    // EMPTY offender list, so a walk that returns no files passes with a green
    // tick while covering nothing at all — a moved directory, a changed
    // extension, a renamed root. Demonstrated on this repo by pointing one
    // gate's walk at a directory holding no `.ts` files: every assertion still
    // passed. The magnitude is the only thing that can tell "clean" from "blind".
    expect(sourceFiles(join(__dirname, "../../src")).length).toBeGreaterThan(100);
  });

  it("no reader silently includes pupils who have left", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.split("/src/")[1];
      // Promotion reads history to decide what moves, including rows it has
      // already marked PROMOTED; the status writer must find a row in ANY
      // state to change it.
      if (rel === "lms/promotion.service.ts" || rel === "lms/lms.service.ts") continue;
      const src = readFileSync(file, "utf8");
      // Each enrolment read, with enough following text to see its `where`.
      for (const m of src.matchAll(/tx\.enrollment\.(findMany|findFirst|groupBy|count)\(\{[\s\S]{0,300}?\}\)/g)) {
        if (!ROSTER_SHAPE.test(m[0])) continue; // an access check, not a roster
        if (!m[0].includes("status")) {
          const line = src.slice(0, m.index ?? 0).split("\n").length;
          offenders.push(`${rel}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the exempted files still exist, so the list cannot rot silently", () => {
    // An exemption naming a file that no longer exists would hide a genuine
    // offender behind a stale entry.
    for (const rel of ["lms/promotion.service.ts", "lms/lms.service.ts"]) {
      expect(files.some((f) => f.endsWith(`/src/${rel}`))).toBe(true);
    }
  });
});

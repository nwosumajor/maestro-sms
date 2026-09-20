// =============================================================================
// "Is this offering mine?" has ONE definition
// =============================================================================
// The rule was written by hand in four places — the scheme of work, the
// gradebook, the CBT exam scope and the LMS content tag — and the fourth got it
// wrong in a way that DISABLED ITSELF: it asked whether the caller taught the
// CLASS (the union, satisfied by any one offering) instead of whether they
// taught THIS SUBJECT in it. A Maths teacher published Physics.
//
// That is this repo's most-recorded shape: a control written several times is
// right all but once. So the spelling is now a single exported function, and
// this gate fails on a fifth hand-rolled copy — which is the only version of
// this test that keeps working after everyone who remembers has moved on.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";

const SRC = join(__dirname, "../../src");
const DEFINITION = join(SRC, "common/teaches.ts");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") && !full.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

/** A `where` naming all three of classId, subjectId and teacherId — the
 *  offering triple — inside one object literal. */
function hasHandRolledTriple(src: string): boolean {
  for (const m of src.matchAll(/where:\s*\{([^{}]*)\}/g)) {
    const body = m[1];
    if (/\bclassId\b/.test(body) && /\bsubjectId\b/.test(body) && /\bteacherId\b/.test(body)) return true;
  }
  return false;
}

describe("the offering rule", () => {
  const files = walk(SRC);

  it("scanned the source tree at all", () => {
    // A walk that finds nothing must not pass.
    expect(files.length).toBeGreaterThan(200);
  });

  it("is defined exactly once, in common/teaches.ts", () => {
    const definition = stripComments(readFileSync(DEFINITION, "utf8"));
    expect(definition).toContain("export async function teachesSubjectInClass");
    expect(hasHandRolledTriple(definition)).toBe(true); // the one legitimate site
  });

  it("is never spelt out again anywhere else", () => {
    const offenders = files
      .filter((f) => f !== DEFINITION)
      .filter((f) => hasHandRolledTriple(stripComments(readFileSync(f, "utf8"))))
      .map((f) => f.slice(SRC.length + 1));
    // Naming them is the point: the failure should be actionable without
    // anybody having to re-derive which rule this is about.
    expect(offenders).toEqual([]);
  });

  it("is what the three subject-owned surfaces actually call", () => {
    // A shared definition nobody calls is not a consolidation. These are the
    // surfaces where a subject belongs to one teacher: the plan for it, the
    // marks for it, and the lessons and live classes published under it.
    for (const f of [
      "lms/syllabus.service.ts",
      "gradebook/term-result.service.ts",
      "lms/lms-content.service.ts",
    ]) {
      const src = stripComments(readFileSync(join(SRC, f), "utf8"));
      expect([f, src.includes("teachesSubjectInClass")]).toEqual([f, true]);
    }
  });
});

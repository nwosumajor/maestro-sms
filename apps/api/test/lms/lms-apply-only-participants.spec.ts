// =============================================================================
// "Apply all" gave 28 pupils a zero, and overwrote a teacher's own mark
// =============================================================================
// The LMS gradebook pulls quiz and assignment scores into the report card's
// assignment (CA) component. A pupil who attempted nothing counts as 0 out of
// full weight in the TABLE — which is exactly how a teacher sees who has not done
// the work:
//
//     quizPossible += meta.fullTotal; // not attempted → 0 earned, full weight
//
// `applyLmsGrades` then wrote that 0 onto the report card for the whole class
// from one press. Verified live, on a class of 30 where two pupils had taken the
// quiz:
//
//     apply -> 201, 30 rows written, 28 of them assignment = 0
//
// and, for a pupil who had a mark entered BY HAND:
//
//     BEFORE apply | assignment 7 | midterm 15
//     AFTER  apply | assignment 0 | midterm 15
//
// Three things wrong at once:
//
//   * it is an automated score penalty on a child, decided by a batch rather
//     than a person (Golden Rule #8: signals for human review, never a verdict,
//     score penalty or record entry on its own);
//   * "did not attempt" is indistinguishable here from absent, newly arrived or
//     exempt;
//   * it destroyed a teacher's own mark — the merge protects the OTHER
//     components (midterm survived) but the assignment slice is overwritten.
//
// It also disagreed with the CBT push sitting beside it, which writes only for
// the candidates who actually sat the paper. Same button, same destination
// column, opposite rule about who gets written.
//
// A considered zero is still one press away — naming the pupil applies to that
// pupil — so what changes is that somebody has to decide it.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/lms/lms-content.service.ts"), "utf8");
const PANEL = readFileSync(join(__dirname, "../../../web/components/lms/LmsGradebook.tsx"), "utf8");
const applyFn = SRC.slice(SRC.indexOf("async applyLmsGrades("), SRC.indexOf("async applyLmsGrades(") + 3000);

describe("who a bulk apply may mark", () => {
  it("skips a pupil who did none of the work", () => {
    expect(applyFn).toMatch(/targetSet \? targetSet\.has\(r\.studentId\) : r\.participated/);
  });

  it("still requires a suggested mark to exist", () => {
    // The original guard. Narrowing must not replace it.
    expect(applyFn).toMatch(/r\.suggestedMark !== null/);
  });

  it("still applies to pupils NAMED explicitly, so a zero remains possible", () => {
    // The teacher's deliberate zero for missed work must survive; it is the
    // automatic one that goes.
    expect(applyFn).toMatch(/targetSet \? targetSet\.has\(r\.studentId\)/);
  });
});

describe("participation is computed from real work", () => {
  const gradebookFn = SRC.slice(SRC.indexOf("async lmsGradebook("), SRC.indexOf("async applyLmsGrades("));

  it("an attempt counts", () => {
    expect(gradebookFn).toMatch(/participated = true;/);
  });

  it("a GRADED submission counts", () => {
    expect(gradebookFn).toMatch(/if \(gradeByKey\.has\(k\)\) participated = true;/);
  });

  it("a missing attempt does NOT count, but still shows as 0 of full weight", () => {
    // Both halves matter: the teacher must still see who has not done it.
    expect(gradebookFn).toMatch(/quizPossible \+= meta\.fullTotal; \/\/ not attempted/);
    // Scoped to the early-return BLOCK, not to what follows it: the
    // `participated = true` for a real attempt legitimately sits right after.
    const at = gradebookFn.indexOf("if (list.length === 0)");
    const block = gradebookFn.slice(at, gradebookFn.indexOf("continue;", at));
    expect(block).not.toMatch(/participated/);
  });

  it("rides on the row so the screen can say so", () => {
    expect(gradebookFn).toMatch(/participated,/);
  });
});

describe("the screen explains the exclusion", () => {
  it("marks a pupil who did not attempt", () => {
    expect(PANEL).toMatch(/not attempted/);
    expect(PANEL).toMatch(/!r\.participated &&/);
  });

  it("says what Apply-all will and will not do", () => {
    expect(PANEL).toMatch(/every student who did the work/);
    expect(PANEL).toMatch(/record a zero deliberately/);
  });
});

describe("coherence with the CBT push", () => {
  it("CBT writes only for candidates who SAT — the rows come from sittings", () => {
    // The rule these two now share: a mark is written for a pupil who did the
    // thing, and for nobody else.
    const cbt = readFileSync(join(__dirname, "../../src/cbt/cbt.service.ts"), "utf8");
    const plan = cbt.slice(cbt.indexOf("const sittings = await tx.cbtSitting.findMany"), cbt.indexOf("const rows = sittings.map"));
    expect(plan).toMatch(/status: \{ in: \[/);
    expect(cbt).toMatch(/const rows = sittings\.map/);
  });
});

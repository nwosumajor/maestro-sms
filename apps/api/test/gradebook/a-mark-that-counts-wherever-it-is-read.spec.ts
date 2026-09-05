// =============================================================================
// A mark counts wherever it is read — the broadsheet cannot disagree with the card
// =============================================================================
// The class broadsheet built its COLUMNS from `class_subject_teacher` alone, and
// then computed each pupil's `average` over those cells and ranked `position` on
// that average. So a mark recorded against a subject the class does not offer
// was not merely missing a column: it was excluded from the average, and every
// other pupil's position moved.
//
// That is the exact defect the ROWS of the same query were fixed for, and the
// comment there argues it in full — "dropping a pupil who placed third silently
// promotes everyone below them — a class position is printed on a report card."
// The columns kept it.
//
// REACHABLE TWO WAYS, both driven against the running stack:
//
//   1. Removing a subject offering is allowed with NO guard while marks exist.
//      Measured: a class with 70 published Mathematics marks went to ZERO
//      columns, every average and every position null, the 70 rows still there.
//   2. `canGradeClassSubject` returns TRUE immediately for a school-wide caller
//      without consulting the offerings, so a principal can record and publish a
//      mark for a subject the class never offered.
//
// And the two documents then disagreed about one pupil in one term: the report
// card reads `{ classId, termId, PUBLISHED }` with no offerings filter, so it
// counted marks the broadsheet had dropped. Both are printed for parents.
//
// After the fix, on the same class with the offering still removed: 9 subjects,
// average 64.89, position 34 of 70 — and 64.89 is exactly what the database
// holds.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";

const SRC = join(__dirname, "../../src");
const read = (rel: string) => {
  try { return stripComments(readFileSync(join(SRC, rel), "utf8")); } catch { return ""; }
};

/** One method's body.
 *
 *  TWO THINGS IN A SIGNATURE CAN OPEN A BRACE THAT IS NOT THE BODY, and both bit
 *  this gate: a destructured/inline PARAMETER type (`q: { classId: string }`) and
 *  an inline RETURN type (`: Promise<{ buffer: Buffer }>`). Taking the first `{`
 *  after the name yields a 35-character "body" and every assertion below then
 *  passes against nothing. So the parameter list is walked to its matching paren,
 *  and the body brace is the first one at ANGLE depth zero — a `{` inside `<...>`
 *  belongs to a type. */
function methodBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at === -1) return "";
  let i = src.indexOf("(", at);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  let angle = 0;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "<") angle += 1;
    else if (ch === ">") angle -= 1;
    else if (ch === "{" && angle === 0) break;
  }
  if (i >= src.length) return "";
  const start = i;
  depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

describe("the class broadsheet counts every mark the class holds", () => {
  const term = read("gradebook/term-result.service.ts");
  const body = methodBody(term, "async getClassBroadsheet(");

  it("found the method it is about", () => {
    // A walk that reads nothing produces no offenders and passes green.
    expect(term.length).toBeGreaterThan(20000);
    expect(body.length).toBeGreaterThan(2000);
  });

  it("takes its columns from the offerings UNION the subjects that carry marks", () => {
    // The fix. Offerings alone is the defect; results alone would lose the empty
    // column a class legitimately offers and has not marked yet.
    expect(body).toMatch(/classSubjectTeacher\.findMany/);
    expect(body).toMatch(/subjectResult\.findMany/);
    // both feed the same set
    expect(body).toMatch(/new Set\(\[[\s\S]{0,400}offerings\.map[\s\S]{0,200}results\.map/);
  });

  it("still unions the ROWS, which was fixed first and must not be traded away", () => {
    expect(body).toMatch(/new Set\(\[[\s\S]{0,400}enrollments\.map[\s\S]{0,200}results\.map/);
  });

  it("ranks position on the average it just computed, over those cells", () => {
    // If the average ever stops covering every mark, position inherits the
    // error silently — that is why the two are asserted together.
    expect(body).toMatch(/average:\s*averageOf\(totals\)/);
    expect(body).toMatch(/position/);
  });

  it("the report card still reads the marks themselves, with no offerings filter", () => {
    // The other side of the agreement. If the CARD ever started filtering by
    // offerings, the two would diverge again from the opposite direction.
    const card = read("reportcards/reportcard.service.ts");
    expect(card.length).toBeGreaterThan(10000);
    expect(card).toMatch(/subjectResult\.findMany\(\{[\s\S]{0,200}status:\s*"PUBLISHED"/);
    expect(card).not.toMatch(/classSubjectTeacher/);
  });
});

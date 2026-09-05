// =============================================================================
// A card that COMPUTES with the school's weighting and PRINTS the platform's
// =============================================================================
// `GradingPolicy` carries two fields a report card has to honour: the letter
// `bands` and the component `components` (what each of exam / midterm /
// assignment / class note is out of). The card was wired to the first and not
// the second — it computed every total with `grading?.components` and then
// printed two descriptions of the weighting taken from the platform default:
//
//   "Maximum mark   40   60   100"                     the column denominators
//   "Term weighting: Exam 60 · Midterm 20 · ..."       a literal string
//
// Measured on a school weighting 45/25/20/10: the card printed a maximum of 60
// over the exam column and 60/20/10/10 at the foot. Both are false there, and
// the denominator is the worse of the two — a pupil scoring 45, which is FULL
// MARKS at that school, is printed under a header saying the maximum is 60, so
// a perfect exam reads as 75%.
//
// The comment directly above the offending line already states the principle:
// "A mark means nothing without its denominator, and a parent reading '37'
// under Exam should not have to find a note three inches below to learn it was
// out of 60." It was applied to the platform's denominator rather than the
// school's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";

const SRC = join(__dirname, "../../src/reportcards/reportcard.service.ts");
const src = stripComments(readFileSync(SRC, "utf8"));

/** The body of `drawCard`, so an assertion cannot be satisfied by the
 *  data-building code above it, which was always correct. */
function drawCardBody(): string {
  const at = src.indexOf("private drawCard(");
  if (at === -1) return "";
  let i = src.indexOf("{", src.indexOf(")", at));
  const start = i;
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

describe("the weighting a report card prints is the school's own", () => {
  const body = drawCardBody();

  it("found the source it is about", () => {
    // A read that finds nothing produces no offenders and passes green.
    expect(src.length).toBeGreaterThan(20000);
    expect(body.length).toBeGreaterThan(8000);
  });

  it("carries the school's components onto the card beside its bands", () => {
    // Both are fields of ONE policy object; carrying one and not the other is
    // exactly how these diverged.
    expect(src).toMatch(/components:\s*grading\?\.components\s*\?\?\s*GRADE_COMPONENTS/);
  });

  it("takes the column denominators from the card, not from the platform default", () => {
    expect(body).toMatch(/d\.components\.find\(\(c\) => c\.key === "exam"\)/);
    expect(body).toMatch(/d\.components\.filter\(\(c\) => c\.key !== "exam"\)/);
    // and no longer reads the platform constant to describe this school
    expect(body).not.toMatch(/GRADE_COMPONENTS\.filter/);
  });

  it("states the weighting at the foot from the same components", () => {
    expect(body).toMatch(/d\.components\.map\(/);
    expect(body).toMatch(/Term weighting: \$\{weighting\}/);
    // The literal it replaced was a factual claim about how the mark was
    // reached, and it was false for every school not on 60/20/10/10.
    expect(body).not.toMatch(/Term weighting: Exam 60/);
  });

  it("does not defend itself with a default at the draw site", () => {
    // The population site defaults (a school with no policy uses the platform's).
    // A SECOND default here would have hidden the missing field in the fixture,
    // which is how the whole class of stub-shaped-wrongly bugs survives.
    expect(body).not.toMatch(/d\.components\s*\?\?/);
  });
});

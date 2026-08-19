// =============================================================================
// A pupil is ranked among the class they SAT the term in
// =============================================================================
// Class position is one of the few numbers on a report card that is about a
// child relative to other children, and it is meaningless unless the "other
// children" are the right ones.
//
// Both the report card and the session report picked the cohort from the pupil's
// CURRENT active enrolment. That is the same class right up until the pupil
// moves — which schools do mid-session for ordinary reasons: a stream change, a
// class rebalance, a family request. From that moment their Term 1 mark, earned in
// the class they were in then, was ranked against the roster of the class they
// are in now.
//
// Measured live by moving one pupil from VOL SS3 B to VOL JSS1 A and re-reading
// their card:
//
//     before   VOL SS3 B    Term 1 English   78   position 10 of 30
//     after    VOL JSS1 A   Term 1 English   78   position 10 of 31
//
// A different year group, and 31 is JSS1 A's thirty plus the incomer. The
// pupil's real classmates were not in the comparison at all — and the same
// group is what every JSS1 A pupil's own card was ranked in, so one pupil moving
// shifted a whole class's positions.
//
// Every subject_result row already records the classId it was earned under, and
// the broadsheet has always keyed on it. This makes the printed card agree.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "../../src", rel), "utf8");

describe("the cohort a position is measured against", () => {
  it("comes from the result row, not from where the pupil is enrolled today", () => {
    const src = read("gradebook/term-result.service.ts");
    const block = src.slice(src.indexOf("// Per-subject class rank."), src.indexOf("const termReports"));
    // The peers are whoever has a result in the same classes this pupil studied
    // in — not whoever is enrolled in one class now.
    expect(block).toMatch(/cohortClassIds = \[\.\.\.new Set\(allResults\.map\(\(r\) => r\.classId\)\)\]/);
    expect(block).toMatch(/classId: \{ in: cohortClassIds \}/);
    expect(block).not.toMatch(/enrollment\.classId/);
    expect(block).not.toMatch(/tx\.enrollment\.findMany/);
  });

  it("groups and looks up by class, so two classes never share a ranking", () => {
    // The key must carry the class. Dropping it merges every class that shares a
    // term and subject into one ranking — a school-wide position printed as a
    // class one.
    const src = read("gradebook/term-result.service.ts");
    expect(src).toMatch(/const key = `\$\{r\.classId\}:\$\{r\.termId\}:\$\{r\.subjectId\}`/);
    expect(src).toMatch(/rankOf\.get\(`\$\{r\.classId\}:\$\{r\.termId\}:\$\{r\.subjectId\}`\)\?\.position/);
    expect(src).toMatch(/rankOf\.get\(`\$\{r\.classId\}:\$\{r\.termId\}:\$\{r\.subjectId\}`\)\?\.ranked/);
  });

  it("still ranks PUBLISHED marks only, whoever is reading", () => {
    // Unchanged and load-bearing: a position has to be the same number for the
    // parent, the pupil and the teacher.
    const src = read("gradebook/term-result.service.ts");
    const block = src.slice(src.indexOf("// Per-subject class rank."), src.indexOf("const termReports"));
    expect(block).toMatch(/status: "PUBLISHED"/);
  });

  it("keeps pupils who have since left in the term they sat", () => {
    // The old query filtered to status ACTIVE. Someone who left in Term 3 still
    // sat Terms 1 and 2; removing them moves everyone else's position after the
    // fact, which is the same "history must not move" rule the frozen figures
    // follow.
    const src = read("gradebook/term-result.service.ts");
    const block = src.slice(src.indexOf("// Per-subject class rank."), src.indexOf("const termReports"));
    expect(block).not.toMatch(/status: "ACTIVE"/);
  });
});

describe("the printed report card", () => {
  it("takes its cohort from the term's own marks", () => {
    const src = read("reportcards/reportcard.service.ts");
    expect(src).toMatch(/const cohortClassId = ownTermRows\[0\]\?\.classId \?\? enrolment\?\.classId \?\? null/);
    // The class average, lowest and highest printed beside a pupil's own mark,
    // and the overall term position, all read this.
    expect(src).toMatch(/where: \{ classId: cohortClassId, termId: term\.id, status: "PUBLISHED" \}/);
    expect(src).toMatch(/where: \{ classId: cohortClassId, termId: \{ in: annualTermIds \}, status: "PUBLISHED" \}/);
  });

  it("NAMES that class in the header", () => {
    // Printing today's class above a term's marks earned elsewhere states the
    // wrong fact in the one line a parent reads first.
    const src = read("reportcards/reportcard.service.ts");
    expect(src).toMatch(/className: cohortClassName,/);
    expect(src).not.toMatch(/className: enrolment\?\.class\?\.name/);
    expect(read("gradebook/term-result.service.ts")).toMatch(
      /const headerClassId = allResults\[0\]\?\.classId \?\? enrollment\?\.classId \?\? null/,
    );
  });

  it("still finds a promotion decision by the pupil's CURRENT class", () => {
    // Deliberately NOT changed. A promotion batch is a decision taken about the
    // class the pupil is in now; keying it on a historical class would silently
    // drop the "PROMOTED TO ..." line from the end-of-year card.
    const src = read("reportcards/reportcard.service.ts");
    expect(src).toMatch(/where: \{ sourceClassId: enrolment\.classId, termId: term\.id, status: "APPROVED" \}/);
  });

  it("falls back to the current enrolment when the term has no marks", () => {
    // Nothing to rank and nothing to get wrong, but the card still needs a class
    // name on it.
    const src = read("reportcards/reportcard.service.ts");
    expect(src).toMatch(/\?\? enrolment\?\.classId \?\? null/);
  });
});

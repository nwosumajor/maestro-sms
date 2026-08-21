// =============================================================================
// A mark that has been published is a statement, and statements do not move
// =============================================================================
// A school can change its grading policy whenever it likes. That is a shipped
// feature — five named scales, four weight presets, an admin screen — and the
// whole point of it is that schools use it.
//
// Every reader of a published mark recomputed from the raw components on
// whatever policy the school had TODAY. So changing the policy in March silently
// rewrote every card printed in December: the pupil, the parent and the office
// all saw a different number from the one on the paper in the family's hands,
// with nothing anywhere recording that it had changed.
//
// Measured on real published rows from the running database, switching scale and
// weights together (60/20/10/10 SIMPLE_LETTER -> 50/30/10/10 WAEC):
//
//     marks (e/m/a/n)   before        after
//     41/15/4/10        70  A         70  B2
//     54/20/5/4         83  A         79  A1
//     57/9/8/7          81  A         74  B2
//
// The last row is the sharpest and is not a re-weighting at all. Marks are
// clamped to their component maximum, so dropping the exam weight from 60 to 50
// DISCARDS the 7 marks above the new ceiling that a teacher had already awarded.
// An A becomes a B.
//
// The fix is the payslip rule applied to the other document a family keeps:
// figures are stamped at publication and read back from the row.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reportedTermGrade, resolveGradingPolicy, resolveGradeBands } from "@sms/types";

const OLD = resolveGradingPolicy({
  scale: "SIMPLE_LETTER",
  weights: { exam: 60, midterm: 20, assignment: 10, classNote: 10 },
});
const NEW = resolveGradingPolicy({
  scale: "WAEC",
  weights: { exam: 50, midterm: 30, assignment: 10, classNote: 10 },
});
const under = (p: typeof OLD, row: Parameters<typeof reportedTermGrade>[0]) =>
  reportedTermGrade(row, p.components, resolveGradeBands(p));

/** The real row from the probe: published as 81 A. */
const MARKS = { exam: 57, midterm: 9, assignment: 8, classNote: 7 };


/** The full text of the call that starts at `anchor`, matched by walking its
 *  parentheses. Asserting the ABSENCE of something inside a fixed-size slice is
 *  only ever as true as the size somebody picked. */
function callAt(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found: ${anchor}`);
  const open = src.indexOf("(", at + anchor.lastIndexOf("findMany"));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced call at ${anchor}`);
}

describe("a published result", () => {
  it("reports the figures it was published with, not today's arithmetic", () => {
    const published = { ...MARKS, status: "PUBLISHED", total: 81, grade: "A" };
    const after = under(NEW, published);
    expect(after.total).toBe(81);
    expect(after.grade).toBe("A");
    expect(after.frozen).toBe(true);
  });

  it("would otherwise have lost seven marks a teacher awarded", () => {
    // Proves the harm is real rather than hypothetical: the same row with
    // nothing stored — i.e. the behaviour before the fix — recomputes lower,
    // and the drop is the exam mark being clamped to the new maximum.
    const recomputed = under(NEW, MARKS);
    expect(recomputed.total).toBe(74);
    expect(recomputed.grade).toBe("B2");
    expect(recomputed.frozen).toBe(false);
    expect(81 - recomputed.total).toBe(57 - 50);
  });

  it("keeps its letter when only the SCALE moves and the total does not", () => {
    // 70 is an A on the platform scale and a B2 on WAEC. Same marks, same total,
    // different word on the card — the change a school makes most often.
    const row = { exam: 41, midterm: 15, assignment: 4, classNote: 10 };
    expect(under(OLD, row).grade).toBe("A");
    expect(under(NEW, row).grade).toBe("B2");
    expect(under(NEW, { ...row, status: "PUBLISHED", total: 70, grade: "A" }).grade).toBe("A");
  });
});

describe("a mark that has NOT been published", () => {
  it("is computed live, so a teacher sees the weighting in force now", () => {
    // The other half of the rule. Freezing a draft would show a teacher a stale
    // number while they are still entering marks.
    for (const status of ["DRAFT", "PENDING_APPROVAL"]) {
      const r = under(NEW, { ...MARKS, status, total: 81, grade: "A" });
      expect(r.frozen).toBe(false);
      expect(r.total).toBe(74);
    }
  });

  it("fails OPEN — a published row with no stored total is computed, not blank", () => {
    // Every row in the live table has both, but a mark that exists must never
    // render as absent. Blank on a report card is worse than a recomputed number.
    expect(under(NEW, { ...MARKS, status: "PUBLISHED", total: null, grade: null }).total).toBe(74);
    expect(under(NEW, { ...MARKS, status: "PUBLISHED", total: 81, grade: null }).frozen).toBe(false);
  });

  it("still reports `complete` from the components, which policy cannot change", () => {
    const partial = { exam: 50, midterm: null, assignment: null, classNote: null };
    expect(under(NEW, { ...partial, status: "PUBLISHED", total: 50, grade: "C6" }).complete).toBe(false);
    expect(under(NEW, { ...MARKS, status: "PUBLISHED", total: 81, grade: "A" }).complete).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// The wiring. Four services read a published mark and they used to disagree
// about where the number came from: the parent dashboard read the stored total
// while the report card, the broadsheet, every class position and the
// scholarship merit signal all recomputed. A parent and their child's card
// showed different marks for the same term.
// -----------------------------------------------------------------------------
const read = (rel: string) => readFileSync(join(__dirname, "../../src", rel), "utf8");

const READERS: Array<[string, string]> = [
  ["the report card", "reportcards/reportcard.service.ts"],
  ["term results, the broadsheet and class positions", "gradebook/term-result.service.ts"],
  ["the scholarship merit signal", "scholarship/scholarship.service.ts"],
];

describe("every reader of a published mark", () => {
  it.each(READERS)("%s reports the stored figures", (_who, file) => {
    const src = read(file);
    expect(src).toMatch(/reportedTermGrade\(/);
  });

  it.each(READERS)("%s passes them wherever it names fields", (_who, file) => {
    // reportedTermGrade takes the three as OPTIONAL fields, so a caller that
    // omits them falls through to the live branch and reinstates the whole
    // defect while still compiling and still matching the assertion above.
    // A call that builds its argument field-by-field must name all three.
    // (Scholarship hands over the whole row instead, which the read below pins.)
    const src = read(file);
    const literals = src.match(/reportedTermGrade\(\s*\{[\s\S]*?\n\s*\},/g) ?? [];
    for (const call of literals) {
      expect(call).toMatch(/\bstatus:/);
      expect(call).toMatch(/\btotal:/);
      expect(call).toMatch(/\bgrade:/);
    }
  });

  // The reads that produce a reported figure, named rather than sniffed for.
  // A rule broad enough to find every one of them also catches the query that
  // counts unfilled components and the one the publish hook re-scores — neither
  // of which forms a total, both of which a heuristic flagged. Naming them is
  // the honest version, and the ones below are every query in the codebase whose
  // rows become a number a family reads.
  it("the report card's class and session reads carry the published figures", () => {
    const src = read("reportcards/reportcard.service.ts");
    const reads = (src.match(/subjectResult\.findMany\(\{[\s\S]*?\n\s*\}\)/g) ?? [])
      .filter((q) => /studentId:\s*true/.test(q));
    expect(reads).toHaveLength(2); // classResults (per-term) and sessionResults (annual)
    for (const q of reads) {
      expect(q).toMatch(/\bstatus:\s*true/);
      expect(q).toMatch(/\btotal:\s*true/);
      expect(q).toMatch(/\bgrade:\s*true/);
    }
  });

  it("the scholarship signal's read carries them", () => {
    const src = read("scholarship/scholarship.service.ts");
    const q = src.slice(src.indexOf("const published = await tx.subjectResult.findMany"));
    expect(q.slice(0, 500)).toMatch(/\bstatus:\s*true[\s\S]{0,80}\btotal:\s*true[\s\S]{0,80}\bgrade:\s*true/);
  });

  it("the gradebook's three reporting reads take the WHOLE row", () => {
    // They have no select at all, which is what makes them safe: every column
    // arrives, including the stored figures. Adding a select here would compile,
    // pass everything above, and quietly restore the defect — so the property
    // being pinned is the absence.
    const src = read("gradebook/term-result.service.ts");
    for (const anchor of [
      "const allResults = await tx.subjectResult.findMany(",
      "const peerRows = (await tx.subjectResult.findMany(",
      "tx.subjectResult.findMany({ where: { classId, termId } })",
    ]) {
      expect(src).toContain(anchor);
      // The WHOLE call, walked by its brackets — not a fixed number of
      // characters after the anchor. A window is a guess about how long the
      // call is, and the guess only has to be wrong once: elsewhere in this
      // suite a 480-character window sat in front of a safeguarding bug for
      // exactly this reason, asserting the absence of something that was
      // thirty lines further down. These three calls are 57–148 characters
      // today, so 220 covered them — until somebody adds a longer `where`.
      expect(callAt(src, anchor)).not.toMatch(/select:/);
    }
  });

  it("the parent dashboard reads the stored total, as it always did", () => {
    expect(read("parent/parent.service.ts")).toMatch(/select:\s*\{[^}]*\btotal:\s*true/s);
  });
});

describe("publication", () => {
  it("stamps the figures it is publishing under", () => {
    // The stored total was last written when the teacher typed the mark. If the
    // policy moved between typing and approval, that figure is not the one this
    // batch is going out under — so the flip to PUBLISHED re-scores.
    const src = read("gradebook/term-result.service.ts");
    const hook = src.slice(src.indexOf('req.type !== "GRADE_PUBLISH"'), src.indexOf("private ctx("));
    expect(hook).toMatch(/academicInTx/);
    expect(hook).toMatch(/status: "PUBLISHED", total: scored\.total, grade: scored\.grade/);
  });

  it("does not stamp on rejection — that path goes back to DRAFT", () => {
    const src = read("gradebook/term-result.service.ts");
    const hook = src.slice(src.indexOf('req.type !== "GRADE_PUBLISH"'), src.indexOf("private ctx("));
    expect(hook).toMatch(/data: \{ status: "DRAFT" \}/);
  });
});

// =============================================================================
// A mark that is not finished is not a fail
// =============================================================================
// `computeTermSubjectGrade` treats a missing component as ZERO — correctly, since
// a term total has to be a number — and returns `complete` to say so. Every
// consumer on the server discarded it:
//
//   const { total, grade } = computeTermSubjectGrade(...)   // complete dropped
//
// So a pupil with only their class note entered (8 of 10) had a term total of 8
// and a letter grade to match, indistinguishable from a pupil who sat everything
// and scored 8. That total then rode through publication to the report card the
// family reads, and into the term average and the class position.
//
// The grading console got this right — it shows "partial" — because it computes
// in the browser and kept the flag. The server threw it away, so nothing
// downstream of the teacher's own screen could tell the two apart.
//
// Nothing here BLOCKS publishing an unfinished mark: a school printing interim
// report cards mid-term is doing something ordinary. The fix is that the mark
// says what it is.
// =============================================================================

import { computeTermSubjectGrade } from "@sms/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "../../src", rel), "utf8");

describe("the computation always knew", () => {
  it("counts an unmarked component as zero AND says it is incomplete", () => {
    const r = computeTermSubjectGrade({ exam: null, midterm: null, assignment: null, classNote: 8 });
    expect(r.total).toBe(8);
    expect(r.complete).toBe(false);
  });

  it("is complete once every component is marked", () => {
    const r = computeTermSubjectGrade({ exam: 50, midterm: 15, assignment: 8, classNote: 9 });
    expect(r.complete).toBe(true);
    expect(r.total).toBe(82);
  });

  it("a genuine 8 and a provisional 8 differ only by that flag", () => {
    // Which is exactly why dropping it loses the distinction entirely.
    const provisional = computeTermSubjectGrade({ exam: null, midterm: null, assignment: null, classNote: 8 });
    const real = computeTermSubjectGrade({ exam: 8, midterm: 0, assignment: 0, classNote: 0 });
    expect(provisional.total).toBe(real.total);
    expect(provisional.complete).not.toBe(real.complete);
  });
});

describe("the server carries it now", () => {
  const src = read("gradebook/term-result.service.ts");

  it("recomputeTotal returns completeness", () => {
    expect(src).toMatch(/\{ total: number \| null; grade: string \| null; complete: boolean \}/);
    expect(src).toMatch(/return \{ total, grade, complete \};/);
  });

  it("no caller destructures the flag away again", () => {
    // The defect was literally this line shape. If it comes back, the report
    // card silently stops distinguishing them.
    expect(src).not.toMatch(/const \{ total, grade \} = this\.recomputeTotal/);
    expect(src).not.toMatch(/const \{ total, grade \} = computeTermSubjectGrade/);
  });
});

describe("the report card says so", () => {
  const src = read("reportcards/reportcard.service.ts");

  it("marks a provisional subject in the table", () => {
    expect(src).toMatch(/sub\.complete \? "" : " \*"/);
  });

  it("explains the asterisk, and only when it applies", () => {
    // A standing disclaimer on every report card is one nobody reads.
    expect(src).toMatch(/d\.subjects\.some\(\(sx\) => !sx\.complete\)/);
    expect(src).toMatch(/Unmarked components count as zero, so this total is provisional/);
  });
});

describe("the approver is told before it reaches a family", () => {
  const src = read("gradebook/term-result.service.ts");

  it("counts the provisional rows in the batch", () => {
    expect(src).toMatch(/const incomplete = pending\.filter\(/);
    expect(src).toMatch(/\[r\.exam, r\.midterm, r\.assignment, r\.classNote\]\.some\(\(v\) => v === null\)/);
  });

  it("puts it in the summary the approvals inbox already shows", () => {
    expect(src).toMatch(/with a component still unmarked, which publishes as if it scored zero/);
  });

  it("says the batch is clean when it is", () => {
    // "12 grades" alone tells an approver nothing about whether to hesitate.
    expect(src).toMatch(/all components marked/);
  });

  it("records the count on the audit entry too", () => {
    expect(src).toMatch(/metadata: \{ submitted: res\.count, incomplete \}/);
  });
});

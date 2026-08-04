// =============================================================================
// Grade scales — chosen from a list, not typed
// =============================================================================
// The question this answers is not "can a school change its bands" but "how do
// we stop them breaking it while doing so". Two answers, in order of how much
// work they save:
//
//   1. NAMED SCALES. Almost every school picks a row — WAEC, plus-grades,
//      Cambridge, US — and types nothing at all.
//   2. THE SHAPE ITSELF. A band carries only its FLOOR; each ceiling is implied
//      by the next band down. So the two ways a hand-typed scale goes wrong —
//      a gap (69 maps to nothing) and an overlap (72 is two grades) — cannot be
//      EXPRESSED, rather than being validated after the fact.
//
// What is left to validate is only what reordering can still break, and that is
// what gradeScaleProblem covers.

import {
  DEFAULT_GRADE_SCALE,
  GRADE_SCALES,
  computeTermSubjectGrade,
  gradeLetter,
  gradeScaleProblem,
  resolveGradeBands,
} from "@sms/types";

describe("the named scales", () => {
  it("offers the scale the question described — A+ from 85", () => {
    const bands = GRADE_SCALES.PLUS_MINUS.bands;
    expect(gradeLetter(92, bands)).toBe("A+");
    expect(gradeLetter(85, bands)).toBe("A+");
    expect(gradeLetter(84, bands)).toBe("A");
    expect(gradeLetter(70, bands)).toBe("A");
  });

  it("every scale covers 0 to 100 with no mark left ungraded", () => {
    // The property that makes a scale usable at all: walk every whole mark and
    // demand a grade for each.
    for (const [key, scale] of Object.entries(GRADE_SCALES)) {
      for (let mark = 0; mark <= 100; mark += 1) {
        expect(`${key}@${mark}:${gradeLetter(mark, scale.bands) !== ""}`).toBe(`${key}@${mark}:true`);
      }
    }
  });

  it("every scale is internally valid by its own rules", () => {
    for (const [key, scale] of Object.entries(GRADE_SCALES)) {
      expect(`${key}:${gradeScaleProblem(scale.bands)}`).toBe(`${key}:null`);
    }
  });

  it("assigns a mark to exactly ONE grade in every scale", () => {
    // An overlap would show up as a mark whose grade depends on iteration order.
    for (const scale of Object.values(GRADE_SCALES)) {
      for (let mark = 0; mark <= 100; mark += 1) {
        const matches = scale.bands.filter((b) => mark >= b.min);
        // Bands are ordered high-to-low, so the FIRST match is the answer and
        // every lower band also matches — that is the design, not an overlap.
        expect(matches[0].grade).toBe(gradeLetter(mark, scale.bands));
      }
    }
  });
});

describe("gradeScaleProblem — what a custom scale may not do", () => {
  const ok = [{ min: 80, grade: "A" }, { min: 50, grade: "B" }, { min: 0, grade: "C" }];

  it("accepts a well-formed custom scale", () => {
    expect(gradeScaleProblem(ok)).toBeNull();
  });

  it("refuses a scale whose lowest band does not reach 0", () => {
    // Otherwise every mark below it has no grade at all — the gap that the
    // floors-only shape prevents at the TOP but not at the bottom.
    const p = gradeScaleProblem([{ min: 80, grade: "A" }, { min: 40, grade: "B" }]);
    expect(p).toMatch(/must start at 0/);
  });

  it("refuses floors that are not strictly descending", () => {
    // Reordering is the one way a floors-only editor can still be broken.
    expect(gradeScaleProblem([{ min: 50, grade: "A" }, { min: 80, grade: "B" }, { min: 0, grade: "C" }]))
      .toMatch(/not below/);
  });

  it("refuses two bands sharing a floor", () => {
    // The grade for that mark would depend on which row was read first.
    expect(gradeScaleProblem([{ min: 50, grade: "A" }, { min: 50, grade: "B" }, { min: 0, grade: "C" }]))
      .toMatch(/not below/);
  });

  it("refuses a mark outside 0-100, or a fractional one", () => {
    expect(gradeScaleProblem([{ min: 120, grade: "A" }, { min: 0, grade: "F" }])).toMatch(/between 0 and 100/);
    expect(gradeScaleProblem([{ min: 70.5, grade: "A" }, { min: 0, grade: "F" }])).toMatch(/whole number/);
  });

  it("refuses a nameless grade and a duplicated one", () => {
    expect(gradeScaleProblem([{ min: 70, grade: "  " }, { min: 0, grade: "F" }])).toMatch(/needs a grade name/);
    expect(gradeScaleProblem([{ min: 70, grade: "A" }, { min: 0, grade: "A" }])).toMatch(/share a grade name/);
  });

  it("refuses a scale with fewer than two grades", () => {
    expect(gradeScaleProblem([{ min: 0, grade: "P" }])).toMatch(/at least two/);
  });
});

describe("resolveGradeBands — a school never grades on an unusable scale", () => {
  it("uses the school's named scale", () => {
    expect(resolveGradeBands({ components: [], scale: "US_LETTER" })[0].grade).toBe("A");
    expect(gradeLetter(85, resolveGradeBands({ components: [], scale: "US_LETTER" }))).toBe("B");
  });

  it("lets valid custom bands beat the named scale", () => {
    const bands = [{ min: 90, grade: "TOP" }, { min: 0, grade: "REST" }];
    expect(gradeLetter(95, resolveGradeBands({ components: [], scale: "WAEC", bands }))).toBe("TOP");
  });

  it("IGNORES invalid custom bands rather than grading on them", () => {
    // A broken scale must never reach a report card. Falling back to the named
    // scale is the safe answer; refusing to grade at all would be worse.
    const broken = [{ min: 40, grade: "A" }, { min: 80, grade: "B" }];
    expect(gradeLetter(85, resolveGradeBands({ components: [], scale: "US_LETTER", bands: broken }))).toBe("B");
  });

  it("falls back to the platform default for a school that has chosen nothing", () => {
    expect(resolveGradeBands(null)).toEqual(GRADE_SCALES[DEFAULT_GRADE_SCALE].bands);
    expect(resolveGradeBands({ components: [] })).toEqual(GRADE_SCALES[DEFAULT_GRADE_SCALE].bands);
  });

  it("falls back for an unknown scale key rather than leaving marks ungraded", () => {
    expect(resolveGradeBands({ components: [], scale: "NONSENSE" })).toEqual(GRADE_SCALES[DEFAULT_GRADE_SCALE].bands);
  });
});

describe("the scale reaches the computed grade", () => {
  it("changes the LETTER without changing the total", () => {
    // The mark is the mark; only its label moves. A school switching scales must
    // not see totals shift.
    const marks = { exam: 50, midterm: 18, assignment: 9, classNote: 9 }; // 86
    const us = computeTermSubjectGrade(marks, undefined, GRADE_SCALES.US_LETTER.bands);
    const plus = computeTermSubjectGrade(marks, undefined, GRADE_SCALES.PLUS_MINUS.bands);
    expect(us.total).toBe(86);
    expect(plus.total).toBe(86);
    expect(us.grade).toBe("B");
    expect(plus.grade).toBe("A+");
  });
});

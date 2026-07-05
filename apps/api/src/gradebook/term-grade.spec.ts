import {
  computeTermSubjectGrade,
  gradeLetter,
  averageOf,
  GRADE_COMPONENTS,
  GRADE_TOTAL_WEIGHT,
} from "@sms/types";

describe("term-weighted subject grading (pure)", () => {
  it("weights sum to exactly 100 (exam 60 + midterm 20 + assignment 10 + note 10)", () => {
    expect(GRADE_TOTAL_WEIGHT).toBe(100);
    expect(GRADE_COMPONENTS.map((c) => c.weight)).toEqual([60, 20, 10, 10]);
  });

  it("full marks in every component gives 100 and an A, marked complete", () => {
    const r = computeTermSubjectGrade({ exam: 100, midterm: 100, assignment: 100, classNote: 100 });
    expect(r.total).toBe(100);
    expect(r.grade).toBe("A");
    expect(r.complete).toBe(true);
  });

  it("applies the 60/20/10/10 weighting correctly", () => {
    // exam 50 -> 30, midterm 80 -> 16, assignment 100 -> 10, note 100 -> 10 = 66
    const r = computeTermSubjectGrade({ exam: 50, midterm: 80, assignment: 100, classNote: 100 });
    expect(r.total).toBe(66);
    expect(r.grade).toBe("B");
  });

  it("treats a missing component as 0 but reports the term incomplete", () => {
    const r = computeTermSubjectGrade({ exam: 100, midterm: null, assignment: null, classNote: null });
    expect(r.total).toBe(60); // only the exam's 60% counts
    expect(r.complete).toBe(false);
  });

  it("clamps out-of-range component scores to 0..100", () => {
    const r = computeTermSubjectGrade({ exam: 150, midterm: -10, assignment: 100, classNote: 100 });
    // exam clamped 100 -> 60, midterm clamped 0 -> 0, assignment 10, note 10 = 80
    expect(r.total).toBe(80);
  });

  it("maps totals to the right letter bands", () => {
    expect(gradeLetter(70)).toBe("A");
    expect(gradeLetter(69.99)).toBe("B");
    expect(gradeLetter(50)).toBe("C");
    expect(gradeLetter(45)).toBe("D");
    expect(gradeLetter(40)).toBe("E");
    expect(gradeLetter(39.99)).toBe("F");
    expect(gradeLetter(0)).toBe("F");
  });

  it("averageOf returns null for an empty session and rounds to 2dp", () => {
    expect(averageOf([])).toBeNull();
    expect(averageOf([60, 70, 80])).toBe(70);
    expect(averageOf([66, 66, 67])).toBe(66.33);
  });
});

import {
  computeTermSubjectGrade,
  gradeLetter,
  averageOf,
  gradeComponentMax,
  GRADE_COMPONENTS,
  GRADE_TOTAL_MAX,
} from "@sms/types";

describe("term-weighted subject grading (pure)", () => {
  it("component maxima sum to exactly 100 (exam 60 + midterm 20 + assignment 10 + note 10)", () => {
    expect(GRADE_TOTAL_MAX).toBe(100);
    expect(GRADE_COMPONENTS.map((c) => c.max)).toEqual([60, 20, 10, 10]);
    expect(gradeComponentMax("exam")).toBe(60);
    expect(gradeComponentMax("midterm")).toBe(20);
    expect(gradeComponentMax("assignment")).toBe(10);
    expect(gradeComponentMax("classNote")).toBe(10);
  });

  it("full marks in every component sum to 100 and an A, marked complete", () => {
    // exam 60/60 + midterm 20/20 + assignment 10/10 + note 10/10 = 100
    const r = computeTermSubjectGrade({ exam: 60, midterm: 20, assignment: 10, classNote: 10 });
    expect(r.total).toBe(100);
    expect(r.grade).toBe("A");
    expect(r.complete).toBe(true);
  });

  it("the term total is the plain SUM of the four raw marks", () => {
    // 50 + 15 + 8 + 9 = 82 -> A
    expect(computeTermSubjectGrade({ exam: 50, midterm: 15, assignment: 8, classNote: 9 }).total).toBe(82);
    // 40 + 12 + 8 + 5 = 65 -> B
    const b = computeTermSubjectGrade({ exam: 40, midterm: 12, assignment: 8, classNote: 5 });
    expect(b.total).toBe(65);
    expect(b.grade).toBe("B");
    // 30 + 10 + 5 + 5 = 50 -> C
    expect(computeTermSubjectGrade({ exam: 30, midterm: 10, assignment: 5, classNote: 5 }).total).toBe(50);
  });

  it("treats a missing component as 0 but reports the term incomplete", () => {
    const r = computeTermSubjectGrade({ exam: 60, midterm: null, assignment: null, classNote: null });
    expect(r.total).toBe(60); // only the exam's 60 marks count so far
    expect(r.complete).toBe(false);
  });

  it("clamps each component to its OWN maximum (not 100)", () => {
    // exam 150 -> 60, midterm -10 -> 0, assignment 20 -> 10, note 10 -> 10 = 80
    const r = computeTermSubjectGrade({ exam: 150, midterm: -10, assignment: 20, classNote: 10 });
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

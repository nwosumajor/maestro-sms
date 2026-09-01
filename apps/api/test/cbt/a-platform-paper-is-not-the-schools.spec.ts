import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";

/**
 * `announceExam` materialises a scholarship exam INSIDE each candidate's
 * tenant, which is right: it keeps every sitting RLS-scoped to the pupil's own
 * school. What was wrong is that the row then looked like one of that school's
 * own exams.
 *
 * Measured live, on a real programme with a qualified candidate:
 *
 *     principal@demo.school   answer-key.pdf -> 200
 *     admin@demo.school       answer-key.pdf -> 200
 *     teacher@demo.school     answer-key.pdf -> 404
 *
 * The leadership of a candidate's own school could print the ANSWER KEY to a
 * cross-school competition before their pupil sat it — and every school with a
 * candidate holds its own copy of that row, so every one of them could.
 *
 * THE TEACHER'S 404 WAS LUCK, NOT A CONTROL: bank access is decided by SUBJECT,
 * and that teacher does not teach the one the programme named. A different
 * teacher would have been an editor.
 *
 * The school administers nothing about a platform paper now. What it keeps is
 * its own pupils' RESULTS, which are theirs to see and which the platform
 * publishes anyway.
 */

const SERVICE = stripComments(
  readFileSync(join(__dirname, "..", "..", "src", "cbt", "cbt.service.ts"), "utf8"),
);

const methodBody = (name: string) => {
  const at = SERVICE.indexOf(`async ${name}(`);
  expect(at).toBeGreaterThan(0);
  const next = SERVICE.indexOf("\n  async ", at + 1);
  return SERVICE.slice(at, next > 0 ? next : undefined);
};

describe("a scholarship exam is the platform's, not the school's", () => {
  it("refuses with 404, so a school is never told what it may not administer", () => {
    // `methodBody` looks for `async NAME(` — this one is a private SYNC method,
    // so it is sliced by name directly.
    const at = SERVICE.indexOf("private assertNotAPlatformExam");
    expect(at).toBeGreaterThan(0);
    const guard = SERVICE.slice(at, SERVICE.indexOf("\n  }", at));
    expect(guard).toMatch(/scholarshipProgramId[\s\S]{0,120}?NotFoundException/);
  });

  it("guards the PAPER and the KEY, which is where this was found", () => {
    expect(methodBody("examPaperPdf")).toMatch(/this\.assertNotAPlatformExam\(exam\)/);
  });

  it("guards every management path, not just the one that was tested", () => {
    // A guard on one door is not a guard. Closing, requesting a publish,
    // requesting the answer release, and writing marks into the school's own
    // gradebook are each a school administering a paper it did not set.
    for (const m of ["setExamStatus", "requestPublish", "requestAnswerRelease", "recordExamGrades"]) {
      expect(`${m}:${/this\.assertNotAPlatformExam\(exam\)/.test(methodBody(m))}`).toBe(`${m}:true`);
    }
  });

  it("keeps it out of the school's own exam console", () => {
    // Hiding is not the control — the direct URL is refused above — but a
    // platform paper listed beside a school's own is how its key came to be one
    // click away.
    const list = methodBody("listExams");
    expect(list).toMatch(/scholarshipProgramId: null/);
  });

  it("does not hide it from the CANDIDATE, who must still sit it", () => {
    // The student branch filters by QUALIFIED application, not by excluding
    // scholarship exams outright — the two branches ask opposite questions.
    const list = methodBody("listExams");
    expect(list).toMatch(/filterScholarshipExams\(tx, p, exams\)/);
  });

  it("leaves results alone, which are the school's own pupils'", () => {
    const results = SERVICE.slice(SERVICE.indexOf("async examResults"));
    expect(results.slice(0, 900)).not.toMatch(/assertNotAPlatformExam/);
  });
});

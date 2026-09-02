/**
 * TWO PROPERTIES, asked for directly:
 *
 *   1. no school can reach a scholarship question, at any stage;
 *   2. a candidate reaches it only once the PLATFORM OWNER has released it,
 *      and only if they qualified.
 *
 * Driven end to end against the running stack; this pins what was found.
 *
 * The whole school side is now thirteen doors and every one answers 404 — the
 * list is never the guard, so each is checked by DIRECT id.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { apiRoutes } from "../support/api-routes";
import { stripComments } from "../support/strip-comments";

const CBT = stripComments(readFileSync(path.join(__dirname, "../../src/cbt/cbt.service.ts"), "utf8"));
const SCH = stripComments(
  readFileSync(path.join(__dirname, "../../src/scholarship/scholarship.service.ts"), "utf8"),
);
/**
 * A method's body, bounded by the NEXT method rather than by the first `\n  }`.
 * That shorter bound cuts a method short at its first nested block closed at
 * class indentation — `recordExamGrades` carries its guard AFTER one, so the
 * slice missed it and the gate reported a guard that was there. The
 * fixed-window failure this repo records, met while writing a gate for it.
 */
const body = (src: string, name: string) => {
  const a = src.indexOf(name);
  expect(a).toBeGreaterThan(-1);
  const next = src.slice(a + name.length).search(/\n  (?:async |private |\/\*\*)/);
  const end = next === -1 ? src.length : a + name.length + next;
  const out = src.slice(a, end);
  // A window that found almost nothing is a window that checks almost nothing.
  expect(out.length).toBeGreaterThan(120);
  return out;
};

describe("no school reaches a scholarship question", () => {
  // EVERY method a school-side CBT route lands on, and the guard it must carry.
  // `requireMarkable` covers the two marking routes that name a question;
  // `markingProgress` does NOT come that way and carries its own — which only
  // driving all thirteen doors revealed, since reading the call graph said it
  // was covered.
  it.each([
    ["async getBankQuestions(", "assertNotAPlatformBank"],
    ["async availability(", "assertNotAPlatformBank"],
    ["async addQuestions(", "assertNotAPlatformBank"],
    ["async updateBank(", "assertNotAPlatformBank"],
    ["private async requireMarkable(", "assertNotAPlatformBank"],
    ["async markingProgress(", "assertNotAPlatformExam"],
    ["async examPaperPdf(", "assertNotAPlatformExam"],
    ["async setExamStatus(", "assertNotAPlatformExam"],
    ["async requestPublish(", "assertNotAPlatformExam"],
    ["async requestAnswerRelease(", "assertNotAPlatformExam"],
    ["async recordExamGrades(", "assertNotAPlatformExam"],
  ])("%s carries %s", (method, guard) => {
    expect(body(CBT, method)).toContain(guard);
  });

  // The two that reach the bank THROUGH a question keep their own wording, so a
  // platform question and one that is simply not the caller's read identically.
  it.each(["async updateQuestion(", "async deleteQuestion("])(
    "%s refuses a platform question in the same words", (m) => {
      expect(body(CBT, m)).toMatch(/bank\.scholarshipProgramId\) throw new NotFoundException\("Question not found"\)/);
    },
  );

  it("is excluded from the school's bank list for every reader", () => {
    expect(body(CBT, "async listBanks(")).toMatch(/scholarshipProgramId: null/);
  });

  // WHAT THE SCHOOL KEEPS. Its own pupils' scores are theirs to see, and the
  // platform publishes them anyway — pinned so the guard cannot quietly grow
  // into hiding a school's own data.
  it("does not guard the school's view of its own pupils' results", () => {
    expect(body(CBT, "async examResults(")).not.toContain("assertNotAPlatform");
  });
});

describe("only a released paper reaches a candidate", () => {
  // THE LISTING MUST ASK WHAT THE START ASKS. This file's own header says a
  // scholarship exam is "invisible to anyone who did not qualify" — true of
  // `startSitting`, and the list beside it never asked, so `start` answered 404
  // while the list handed any pupil in the school the paper's title, its
  // window and its question COUNT.
  it("the paper list requires a QUALIFIED application", () => {
    const papers = body(SCH, "async examPapers(");
    expect(papers).toMatch(/status: "QUALIFIED"/);
    expect(papers).toMatch(/studentId: p\.userId/);
    // and the refusal comes BEFORE the exams are read, so nothing about them
    // can be assembled for somebody with no part in the programme
    expect(papers.indexOf('status: "QUALIFIED"')).toBeLessThan(papers.indexOf("cbtExam.findMany"));
    expect(papers).toMatch(/if \(!qualified\) return \[\]/);
  });

  // The sitting routes add exactly ONE thing on top of the CBT service's own
  // authorisation — that the exam is a scholarship exam at all — and every one
  // of them must, or an always-on route reaches a school's paid exam.
  it("every scholarship sitting route re-asserts it is a scholarship exam", () => {
    const routes = apiRoutes().filter((r) => /^(GET|POST) \/scholarships\/(exams|sittings)\//.test(r.key));
    expect(routes.length).toBeGreaterThanOrEqual(6);
    for (const r of routes) {
      const m = /this\.(scholarships|admin)\.(\w+)\(/.exec(r.body);
      expect(m).not.toBeNull();
      const svc = body(SCH, `async ${m![2]}(`);
      expect(svc).toMatch(/scholarshipProgramId|assertScholarshipSitting/);
    }
  });
});

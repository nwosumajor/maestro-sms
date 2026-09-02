/**
 * A scholarship paper is MATERIALISED as a question bank inside each
 * candidate's own school — which is what keeps every sitting RLS-scoped — and
 * the bank then looked like one of that school's own.
 *
 * `assertNotAPlatformExam` closed the EXAM's doors: the paper and key PDFs,
 * closing it, requesting a publish, requesting the answer release, and
 * recording its marks into the school's gradebook. The BANK carried no marker
 * at all.
 *
 * MEASURED LIVE, on a real programme with a qualified candidate at the demo
 * school:
 *
 *     principal    GET /cbt/banks                -> the platform bank listed
 *     principal    GET /cbt/banks/:id/questions  -> 200  ANSWER KEY: [1,0]
 *     school admin same                          -> 200  ANSWER KEY: [1,0]
 *
 * The answer key to a cross-school competition, to the candidate's own school,
 * before the pupil sat it. That is the leak the exam fix exists to prevent,
 * reached through a door it did not close.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { stripComments } from "../support/strip-comments";

const SRC = stripComments(
  readFileSync(path.join(__dirname, "../../src/cbt/cbt.service.ts"), "utf8"),
);
const ANNOUNCE = stripComments(
  readFileSync(path.join(__dirname, "../../src/scholarship/scholarship-admin.service.ts"), "utf8"),
);

const methodBody = (name: string) => {
  const a = SRC.indexOf(name);
  expect(a).toBeGreaterThan(-1);
  return SRC.slice(a, SRC.indexOf("\n  }", a));
};

describe("a platform paper is not the school's bank", () => {
  // THE MARKER. Without it there is nothing to guard on, and a bank whose exam
  // has since gone would stop being recognisable at all.
  it("the announce marks the bank it materialises", () => {
    const a = ANNOUNCE.indexOf("cbtQuestionBank.create(");
    expect(a).toBeGreaterThan(-1);
    expect(ANNOUNCE.slice(a, a + 500)).toMatch(/scholarshipProgramId: programId/);
  });

  // ONE GUARD, ON EVERY DOOR — the sentence the exam fix records. A guard on
  // the one path somebody happened to test is not a guard.
  it.each([
    "async availability(",
    "async getBankQuestions(",
    "async updateBank(",
  ])("%s refuses a platform bank", (name) => {
    expect(methodBody(name)).toMatch(/assertNotAPlatformBank\(bank\)/);
  });

  // These reach the bank THROUGH the question, so their refusal is worded
  // "Question not found" and must stay that way — a platform question and one
  // that simply is not the caller's have to read identically.
  it.each(["async updateQuestion(", "async deleteQuestion("])(
    "%s refuses a platform question in the same words", (name) => {
      const body = methodBody(name);
      expect(body).toMatch(/bank\.scholarshipProgramId\) throw new NotFoundException\("Question not found"\)/);
    },
  );

  // AN ASSERT, NOT A CLAUSE IN `canTouchBank`: the questions read admits a
  // `cbt.review` holder WITHOUT consulting that predicate, so a rule written
  // there would have missed the very path the leak came through.
  it("does not rely on canTouchBank, which that path bypasses", () => {
    const questions = methodBody("async getBankQuestions(");
    expect(questions).toMatch(/canReview/);
    expect(questions.indexOf("assertNotAPlatformBank")).toBeGreaterThan(-1);
    const guard = methodBody("private assertNotAPlatformBank(");
    expect(guard).toMatch(/scholarshipProgramId/);
    expect(guard).toMatch(/NotFoundException/);
  });

  // 404, NOT 403: the school can see that its pupils have a scholarship exam,
  // so the refusal says only that this is not theirs to administer.
  it("refuses with the same words as a bank that does not exist", () => {
    expect(methodBody("private assertNotAPlatformBank(")).toMatch(/"Bank not found"/);
  });

  // IT IS ALSO OUT OF THE LIST — not as the control, since the direct id is
  // refused, but because a platform paper listed beside the school's own is how
  // its key came to be one click away.
  it("is excluded from the school's bank list for every reader", () => {
    const list = methodBody("async listBanks(");
    expect(list).toMatch(/const notPlatform = \{ scholarshipProgramId: null \}/);
    // BOTH branches — school-wide/reviewer AND the teacher's own set.
    expect((list.match(/notPlatform/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  // WHAT THE SCHOOL KEEPS. Its pupils' own results stay theirs to see, exactly
  // as the exam fix pinned for `examResults`.
  it("does not guard the school's own banks", () => {
    const create = methodBody("async createBank(");
    expect(create).not.toMatch(/assertNotAPlatformBank/);
  });
});

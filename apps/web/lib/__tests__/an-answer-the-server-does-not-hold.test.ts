/**
 * An answer the screen shows must be one the server holds.
 *
 * Every save in the exam room is OPTIMISTIC — the tick lands on screen and the
 * POST follows — and a failed POST used to leave the tick standing. The
 * candidate saw their choice selected, believed it recorded, and the script
 * held nothing.
 *
 * It is not hypothetical: the per-tenant limiter is 1,200 requests a minute
 * KEYED ON THE SCHOOL, and an exam hall is precisely where one school makes
 * many at once. A school's own wifi does the same thing for free.
 *
 * Read from the source because this is a CONTROL on a child's marks, and the
 * failure is invisible to every API test — the server behaved correctly.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "components/cbt/CbtExamRoom.tsx");
const src = readFileSync(SRC, "utf8");

const bodyOf = (name: string) => {
  const a = src.indexOf(name);
  expect(a).toBeGreaterThan(-1);
  return src.slice(a, src.indexOf("\n  };", a));
};

describe("an answer the server does not hold", () => {
  // A transient 429 clears in seconds, so the first answer is to try again —
  // telling a candidate mid-exam to re-click is a worse product than a retry.
  it("retries a failed save before giving up", () => {
    const save = bodyOf("const saveAnswer = React.useCallback(");
    expect(save).toMatch(/for \(let attempt = 0; attempt < \d; attempt\+\+\)/);
    expect(save).toMatch(/setTimeout\(r, waitMs\)/);
  });

  // The API computes exactly when the per-school window reopens. Guessing a
  // few hundred milliseconds against a window a minute away burns every
  // attempt for nothing.
  it("honours the server's Retry-After rather than guessing", () => {
    const save = bodyOf("const saveAnswer = React.useCallback(");
    expect(save).toMatch(/headers\.get\("retry-after"\)/);
    // capped, so a pathological value cannot park the save for ever
    expect(save).toMatch(/Math\.min\(after \* 1000 \+ 250, 65_000\)/);
  });

  // AND THE PROXY HAS TO CARRY IT. The BFF rebuilds the header set from
  // scratch, so whatever it does not name never reaches the browser — the same
  // defect as the dropped Content-Disposition this repo already records.
  it("the BFF forwards Retry-After and the budget headers", () => {
    const proxy = readFileSync(
      path.join(process.cwd(), "app/api/sms/[...path]/route.ts"),
      "utf8",
    );
    expect(proxy).toMatch(/"retry-after", "x-ratelimit-limit", "x-ratelimit-remaining"/);
  });

  // FLAGGED FROM THE FIRST FAILURE, not after the last attempt: a retry that
  // takes a minute would otherwise leave the answer looking saved for a minute,
  // which is the lie being fixed.
  it("flags the question from the first failure, not after the last retry", () => {
    const save = bodyOf("const saveAnswer = React.useCallback(");
    const okReturn = save.indexOf("if (last?.ok) return null;");
    const flag = save.indexOf("mark(questionId, true);");
    expect(flag).toBeGreaterThan(okReturn);
    expect(flag).toBeLessThan(save.indexOf("last.status < 500"));
  });

  // A REFUSAL IS NOT A BLIP. 400/403/409 mean the server has decided, and
  // retrying only delays telling the candidate.
  it("does not retry a refusal, only a limiter or a server fault", () => {
    const save = bodyOf("const saveAnswer = React.useCallback(");
    expect(save).toMatch(/last\.status < 500 && last\.status !== 429/);
  });

  // THE PROPERTY. Both writers mark the question, and both mark it on FAILURE
  // and clear it on success — a marker that is only ever set is a marker that
  // never goes away.
  it("marks a question whose answer did not save, on both writers", () => {
    for (const name of ["const pick = async (", "const write = async ("]) {
      const body = bodyOf(name);
      expect(body).toMatch(/mark\(questionId, err !== null\)/);
    }
  });

  // The choice STAYS on screen. Reverting it would lose the candidate's intent
  // over a transient failure, which is a worse answer than showing it unsaved.
  it("does not throw the candidate's answer away", () => {
    const pick = bodyOf("const pick = async (");
    expect(pick).toMatch(/setS\(\(cur\) => \(\{ \.\.\.cur, answers: \{ \.\.\.cur\.answers, \[questionId\]: choiceIndex \} \}\)\)/);
    // NOTHING PUTS IT BACK. Anchored on the shape rather than one spelling:
    // a revert through a local alias (`delete a[questionId]`) slipped past a
    // pattern naming `answers[questionId]`, which is the match-by-accident
    // class — so the rule is that the handler holds ONE setS and no delete.
    expect(pick).not.toMatch(/\bdelete\b/);
    expect((pick.match(/setS\(/g) ?? []).length).toBe(1);
  });

  // NAMED, not just counted. "Something went wrong" sends a candidate looking;
  // the question numbers tell them exactly what to click again.
  it("names the unsaved questions rather than only counting them", () => {
    expect(src).toMatch(/unsavedCount === 1 \? "One answer has" :/);
    expect(src).toMatch(/\.map\(\(q, i\) => \(unsaved\[q\.id\] \? i \+ 1 : null\)\)/);
  });

  // A THIRD navigator state. Colouring an unsaved answer as "answered" is the
  // lie being fixed, and colouring it as "not answered" is a different lie.
  it("shows unsaved as its own state in the navigator, not as answered", () => {
    expect(src).toMatch(/notSaved\s*\n\s*\? "border-destructive/);
    expect(src).toMatch(/answered but NOT saved/);
  });

  // SUBMIT ASKS ABOUT IT SEPARATELY. An unsaved answer is a different fact
  // from an unanswered one — the candidate DID answer — so a single "some
  // questions are unanswered" prompt would understate what they are losing.
  it("warns before a submit that would score the paper without them", () => {
    expect(src).toMatch(/could not be saved \(question/);
    expect(src).toMatch(/scores this paper WITHOUT them/);
    // and it is asked BEFORE the ordinary unanswered check
    expect(src.indexOf("could not be saved (question")).toBeLessThan(
      src.indexOf("still unanswered. Submit anyway?"),
    );
  });
});

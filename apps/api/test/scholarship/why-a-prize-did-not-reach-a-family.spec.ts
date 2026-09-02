/**
 * An award that did not reach a family says WHICH of the three things happened.
 *
 * `disburseFeesCredit` refuses for three different reasons — the pupil owed
 * nothing, the open invoice is in another currency, or the school does not bill
 * in the award's currency at all — and only some of them need somebody to act.
 * The audit row has recorded which since that arm was written, under a comment
 * saying exactly why it matters. The operator's own review queue carried a bare
 * `disbursed: false` and stated ONE of the three as though it were always the
 * reason, so an award with simply no bill to credit sent an operator to check a
 * currency setting that was perfectly correct.
 *
 * Found by running the exercise: a 1st-place winner at a school billing GHS,
 * on a programme denominated NGN, came back `disbursed=false` with the console
 * asserting a cause it had not been told.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { disbursementIssueOf } from "../../src/scholarship/scholarship-admin.service";

const SRC = path.join(__dirname, "../../src/scholarship/scholarship-admin.service.ts");
const src = readFileSync(SRC, "utf8");

describe("why a prize did not reach a family", () => {
  // THREE REASONS, THREE SENTENCES. A shared one is the defect being fixed.
  it("says something different for each refusal", () => {
    const said = [
      disbursementIssueOf({ ok: false, reason: "nothing_outstanding" }, "NGN"),
      disbursementIssueOf({ ok: false, reason: "currency_mismatch", invoiceCurrency: "USD" }, "NGN"),
      disbursementIssueOf({ ok: false, reason: "school_bills_another_currency", schoolCurrency: "GHS" }, "NGN"),
    ];
    expect(new Set(said).size).toBe(3);
    for (const s of said) expect(s.length).toBeGreaterThan(30);
  });

  // NAMES BOTH CURRENCIES. "A currency mismatch" leaves an operator to work out
  // which two, on the one screen that holds both facts.
  it("names the currencies rather than saying they differ", () => {
    expect(disbursementIssueOf({ ok: false, reason: "currency_mismatch", invoiceCurrency: "USD" }, "NGN"))
      .toMatch(/USD.*NGN/);
    expect(disbursementIssueOf({ ok: false, reason: "school_bills_another_currency", schoolCurrency: "GHS" }, "NGN"))
      .toMatch(/GHS.*NGN/);
  });

  // NOT EVERYTHING IS A PROBLEM TO CHASE. A family that owes nothing today had
  // no bill to credit, and telling an operator to post it by hand would send
  // them to do something that should not happen.
  it("does not ask for a manual posting where nothing is owed", () => {
    const s = disbursementIssueOf({ ok: false, reason: "nothing_outstanding" }, "NGN");
    expect(s).not.toMatch(/by hand/);
    expect(s).toMatch(/nothing outstanding/i);
    // and the two that DO need action say so
    for (const o of [
      { ok: false as const, reason: "currency_mismatch" as const, invoiceCurrency: "USD" },
      { ok: false as const, reason: "school_bills_another_currency" as const, schoolCurrency: "GHS" },
    ]) expect(disbursementIssueOf(o, "NGN")).toMatch(/by hand/);
  });

  // STORED ON THE AWARD, not re-derived at read time. A school's currency can
  // change after the award, and re-deriving would then answer differently from
  // what actually happened.
  it("writes the reason onto the application when disbursement fails", () => {
    expect(src).toMatch(/data: \{ disbursementIssue: disbursementIssueOf\(disbursement, awardCurrency\) \}/);
  });

  // AND CLEARS IT WHEN IT SUCCEEDS. A stale reason on a credited award is a
  // worse statement than none.
  it("clears the reason on a successful disbursement, both kinds", () => {
    const a = src.indexOf('disbursement.kind === "INVOICE"');
    const block = src.slice(a, a + 400);
    expect((block.match(/disbursementIssue: null/g) ?? []).length).toBe(2);
  });

  // ONE DEFINITION. The console rendering its own fourth reading is how the
  // screen and the audit log came to disagree in the first place.
  it("the console states the stored reason rather than composing one", () => {
    const web = readFileSync(
      path.join(__dirname, "../../../../apps/web/components/operator/ScholarshipAdmin.tsx"),
      "utf8",
    );
    expect(web).toMatch(/a\.disbursed === false\s*\n\s*\? a\.disbursementIssue \?\?/);
    // an award decided before the column existed cannot say which it was, and
    // inventing one would be worse than pointing at the audit log
    expect(web).toMatch(/check the audit log for it/);
    expect(web).not.toMatch(/the school does not bill in the award's currency, so this needs posting by hand/);
  });
});

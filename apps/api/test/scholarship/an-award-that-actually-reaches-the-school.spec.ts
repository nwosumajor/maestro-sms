import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";
import { DISBURSABLE_AWARD_KINDS, SCHOLARSHIP_AWARD_KINDS, isDisbursableAwardKind } from "@sms/types";

/**
 * TWO WAYS A SCHOLARSHIP REACHED NOBODY, both reported as success.
 *
 * 1. `SUBSCRIPTION_CREDIT` was selectable and implemented by nothing. `decide`
 *    disburses under `if (awardKind === "FEES_CREDIT")` and has no other
 *    branch, so an award of the other kind marked the application AWARDED, told
 *    the family they had won, spent one of the three positions — and moved no
 *    money, in silence.
 *
 * 2. CBT is a PREMIUM module and `announceExam` never asked. It runs on the
 *    privileged client, so it created an exam in a STANDARD school, notified
 *    the family "sit it under CBT Exams", and handed them a link that answers
 *    404. `collectExamResults` then found no sitting and skipped them, so the
 *    pupil could never be scored and therefore never awarded — with nothing
 *    anywhere saying why. Measured live: `GET /cbt/exams` -> 404 on STANDARD,
 *    200 on ENTERPRISE.
 */

const src = (...p: string[]) =>
  stripComments(readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8"))
    
    ;

const ADMIN = src("apps", "api", "src", "scholarship", "scholarship-admin.service.ts");
const CONTROLLER = src("apps", "api", "src", "scholarship", "scholarship.controller.ts");
const UI = src("apps", "web", "components", "operator", "ScholarshipAdmin.tsx");

describe("an award kind that cannot pay out is not offered", () => {
  it("separates what can be STORED from what can be PAID", () => {
    // The stored domain keeps the value — no live programme uses it, and
    // removing it would make any that did unreadable.
    expect(SCHOLARSHIP_AWARD_KINDS).toContain("SUBSCRIPTION_CREDIT");
    expect(DISBURSABLE_AWARD_KINDS).not.toContain("SUBSCRIPTION_CREDIT");
    expect(isDisbursableAwardKind("FEES_CREDIT")).toBe(true);
    expect(isDisbursableAwardKind("SUBSCRIPTION_CREDIT")).toBe(false);
  });

  it("every disbursable kind has a branch that actually pays it", () => {
    // The rule this exists to keep: a kind on that list must move money. If a
    // second one is added without a branch, this fails rather than shipping
    // another silent award.
    for (const kind of DISBURSABLE_AWARD_KINDS) {
      expect(ADMIN).toMatch(new RegExp(`awardKind \\?\\? "${kind}"\\) === "${kind}"`));
    }
  });

  it("is refused at the boundary, so it cannot be selected", () => {
    expect(CONTROLLER).toMatch(/awardKind: z\.enum\(DISBURSABLE_AWARD_KINDS\)/);
  });

  it("is refused again at AWARD, for a programme stored before that", () => {
    expect(ADMIN).toMatch(/if \(!isDisbursableAwardKind\(program\?\.awardKind \?\? "FEES_CREDIT"\)\)/);
  });

  it("refuses BEFORE the row is claimed, so no position is consumed", () => {
    // Refusing after the claim would mark it AWARDED and then throw — the
    // application would be finalised with nothing disbursed, which is the
    // defect wearing a different hat.
    const m = ADMIN.slice(ADMIN.indexOf("async decide"));
    const body = m.slice(0, m.indexOf("\n  async "));
    expect(body.indexOf("isDisbursableAwardKind")).toBeGreaterThan(-1);
    expect(body.indexOf("isDisbursableAwardKind")).toBeLessThan(body.indexOf("claimed.count === 0"));
  });
});

describe("every qualified candidate can sit, whatever their school pays for", () => {
  it("no longer excludes a school for want of the PREMIUM CBT module", () => {
    // This DID exclude them, and rightly so at the time: the only way to sit
    // was `/cbt`, which is module-gated, so a candidate there was notified and
    // then met a 404.
    //
    // The scholarship surface now serves the paper itself and is always-on, so
    // the exclusion became the thing standing between a qualified pupil and
    // their exam — it skipped creating their school's exam row, and with no row
    // there is nothing to open. ONE FIX CANCELLING ANOTHER is invisible in
    // either one's tests; it took exercising the whole flow end to end.
    expect(ADMIN).not.toMatch(/cannotSit/);
    expect(ADMIN).not.toMatch(/isEnabled\(schoolId, MODULES\.CBT\)/);
  });

  it("notifies every qualified candidate, with nobody skipped", () => {
    // THE LOOP THAT COUNTS, found from its own tail. `for (const c of
    // candidates)` appears three times and `notifyFamily` five, so anchoring on
    // either alone picked a region in a different method — and the assertion
    // then passed against nothing, which a mutation caught rather than a
    // reading.
    const tail = ADMIN.indexOf("notified += 1");
    const head = ADMIN.lastIndexOf("for (const c of candidates) {", tail);
    expect(head).toBeGreaterThan(0);
    const body = ADMIN.slice(head, tail);
    expect(body).toMatch(/await this\.notifyFamily\(/);
    expect(body).not.toMatch(/continue;/);
  });

  it("and the surface that serves them is still the always-on one", () => {
    // The guarantee this rests on. If the sitting routes ever move back behind
    // the paid module, removing the exclusion above becomes wrong again.
    const CONTROLLER = src("apps", "api", "src", "scholarship", "scholarship.controller.ts");
    expect(CONTROLLER).toMatch(/@Post\("exams\/:programId\/start"\)/);
    expect(CONTROLLER).not.toMatch(/@RequireModule/);
  });
});

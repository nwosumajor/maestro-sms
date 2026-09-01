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

describe("a candidate who cannot sit is not told to sit", () => {
  it("asks each school whether it actually has the CBT module", () => {
    expect(ADMIN).toMatch(/this\.modules\.isEnabled\(schoolId, MODULES\.CBT\)/);
  });

  it("does not create an exam for a school that cannot open it", () => {
    expect(ADMIN).toMatch(/for \(const id of blocked\) bySchool\.delete\(id\)/);
  });

  it("does not notify somebody whose link would 404", () => {
    // A notice with a dead link is worse than none: it tells a family to go and
    // do something the product will refuse them.
    expect(ADMIN).toMatch(/if \(!bySchool\.has\(c\.schoolId\)\) continue;/);
  });

  it("refuses outright when NOBODY can sit, rather than reporting zero", () => {
    // "notified: 0" with a 201 is the silent-partial-success shape.
    expect(ADMIN).toMatch(/if \(bySchool\.size === 0\)[\s\S]{0,200}?BadRequestException/);
  });

  it("reports the schools it left out, by name", () => {
    expect(ADMIN).toMatch(/return \{ notified, cbtExams, arena, cannotSit \}/);
    expect(ADMIN).toMatch(/cannotSit,\s*\n\s*\}\);/); // audited too
  });

  it("says so on the console, and not as a success", () => {
    expect(UI).toMatch(/d\?\.cannotSit\?\.length/);
    expect(UI).toMatch(/ok: !missed/);
    expect(UI).toMatch(/cannot sit/);
  });
});

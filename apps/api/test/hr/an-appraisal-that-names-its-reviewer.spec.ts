import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `reviewerId` has been accepted by the API since the module shipped, defaulting
 * to the CREATOR, and no screen ever sent one. So every appraisal in the product
 * recorded HR as the reviewer, whoever actually did the review.
 *
 * That is not cosmetic, because ONE thing reads the field and it is a report a
 * school acts on: `StaffHandoverService` lists "appraisals they are REVIEWING"
 * with `where: { reviewerId: userId }`. With the reviewer always the creator, a
 * head of department leaving took their in-flight reviews with them invisibly,
 * while the HR clerk leaving appeared to owe the school every appraisal in it.
 *
 * AND THE VALUE WAS TAKEN ON TRUST — not staff, not still here, not checked to
 * exist. Latent only because no screen sent one; a screen is being given to it
 * now, which is exactly when that stops being latent.
 */

const src = (...p: string[]) =>
  readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SERVICE = src("apps", "api", "src", "hr", "reviews.service.ts");
const HANDOVER = src("apps", "api", "src", "hr", "staff-handover.service.ts");
const PANEL = src("apps", "web", "components", "hr", "ReviewsPanel.tsx");
const PAGE = src("apps", "web", "app", "(app)", "hr", "staff", "[userId]", "page.tsx");

const createBody = (() => {
  const m = SERVICE.slice(SERVICE.indexOf("async createAppraisal"));
  return m.slice(0, m.indexOf("\n  }"));
})();

describe("a named reviewer is checked before it is stored", () => {
  it("asks the two questions every other duty here asks", () => {
    expect(createBody).toMatch(/assertStaff\(\s*\n?\s*tx,\s*\n?\s*reviewerId/);
    expect(createBody).toMatch(/assertStillHere\(tx, reviewerId/);
  });

  it("checks only when somebody ELSE is named", () => {
    // The caller is signed in, still here, and holds the permission that got
    // them here — making the ordinary act depend on a lookup that could refuse
    // them is the fix causing the outage.
    expect(createBody).toMatch(/if \(reviewerId !== p\.userId\)/);
  });

  it("still defaults to the creator, so nothing moves for an unnamed reviewer", () => {
    expect(createBody).toMatch(/const reviewerId = input\.reviewerId \?\? p\.userId/);
  });

  it("names a way out that fits the person who was wrong", () => {
    // The refusal's trailing sentence was fixed text about the student
    // discipline area — right when a pupil is the SUBJECT of a record, and
    // wrong when one is named as a REVIEWER, where it points at a remedy that
    // has nothing to do with what the user was doing.
    expect(SERVICE).toMatch(/wayOut = "A pupil's record belongs in the student discipline area\."/);
    expect(SERVICE).toMatch(/\$\{wayOut\}/);
    expect(createBody).toMatch(/leave the reviewer blank to review it yourself/);
  });
});

describe("the field the handover report depends on can be set", () => {
  it("is still what the handover reads", () => {
    // If this stops being the field, the picker is decorative again.
    expect(HANDOVER).toMatch(/appraisal\.findMany\(\{[\s\S]{0,120}?reviewerId: userId/);
  });

  it("is offered on the screen, sourced from the staff register", () => {
    expect(PAGE).toMatch(/canAppraise \? apiGet<Serialized<EmployeeDto>\[\]>\("\/hr\/employees"\)/);
    expect(PANEL).toMatch(/id="ap-reviewer"/);
  });

  it("omits the field when blank rather than sending an empty string", () => {
    // The server reads an absent reviewer as "the creator", and "" is not a uuid.
    expect(PANEL).toMatch(/\.\.\.\(reviewerId \? \{ reviewerId \} : \{\}\)/);
  });

  it("does not offer the appraisee as their own reviewer", () => {
    expect(PANEL).toMatch(/r\.userId !== userId/);
  });
});

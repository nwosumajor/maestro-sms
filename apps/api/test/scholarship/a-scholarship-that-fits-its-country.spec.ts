/**
 * A scholarship was global on a platform whose catalogue holds 37 countries,
 * and every award was denominated in one hard-coded currency.
 *
 * Measured on a 5,000-applicant exercise: THREE OF SIX awards were refused
 * because one school bills in GHS while `AWARD_CURRENCY = "NGN"` was a
 * constant. Each stood as AWARDED with nothing posted, waiting for somebody to
 * enter it by hand.
 */
import { scholarshipCoversCountry } from "@sms/types";

describe("which schools a scholarship is open to", () => {
  // NULL AND EMPTY MEAN EVERY COUNTRY — the behaviour of every programme
  // authored before the column, so nothing moves for them.
  it.each([[null], [undefined], [[] as string[]]])("treats %p as every country", (scope) => {
    expect(scholarshipCoversCountry(scope as never, "GH", "NG")).toBe(true);
    expect(scholarshipCoversCountry(scope as never, "SG", "NG")).toBe(true);
  });

  it("admits a school inside the scope and refuses one outside", () => {
    expect(scholarshipCoversCountry(["NG", "GH"], "GH", "NG")).toBe(true);
    expect(scholarshipCoversCountry(["NG", "GH"], "KE", "NG")).toBe(false);
  });

  // A school with NO country set resolves to the platform's home country,
  // exactly as `resolveRegion` does everywhere else. Treating it as "nowhere"
  // would silently exclude every school that has never set a region — which is
  // most of them.
  it("reads a school with no country as the platform's home country", () => {
    expect(scholarshipCoversCountry(["NG"], null, "NG")).toBe(true);
    expect(scholarshipCoversCountry(["GH"], null, "NG")).toBe(false);
    expect(scholarshipCoversCountry(["GH"], undefined, "GH")).toBe(true);
  });

  it("compares case-insensitively, so a lower-case column still matches", () => {
    expect(scholarshipCoversCountry(["NG"], "ng", "NG")).toBe(true);
  });
});

/**
 * The two halves of the country rule are ONE rule: what a family is offered and
 * what the server will accept. A second spelling is how they drift, and the
 * failure mode is the control-that-403s shape this repo keeps finding.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { stripComments } from "../support/strip-comments";

const SVC = stripComments(readFileSync(path.join(__dirname, "../../src/scholarship/scholarship.service.ts"), "utf8"));
const ADMIN = stripComments(
  readFileSync(path.join(__dirname, "../../src/scholarship/scholarship-admin.service.ts"), "utf8"),
);

describe("the listing and the apply guard ask the same question", () => {
  it("both resolve the scope through the shared predicate", () => {
    const uses = SVC.match(/scholarshipCoversCountry\(/g) ?? [];
    // One in `openPrograms` (what is offered) and one in `apply` (what is
    // accepted). Fewer than two means one half is deciding for itself.
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  it("checks the scope BEFORE looking the pupil up, so the refusal is about the programme", () => {
    const apply = SVC.slice(SVC.indexOf("async apply("));
    const body = apply.slice(0, apply.indexOf("\n  async "));
    expect(body.indexOf("scholarshipCoversCountry")).toBeGreaterThan(-1);
    expect(body.indexOf("scholarshipCoversCountry")).toBeLessThan(body.indexOf("applicableStudentIds"));
  });

  it("names the countries in the refusal rather than saying only 'not eligible'", () => {
    expect(SVC).toMatch(/open to schools in \$\{program\.countries\.join/);
  });
});

describe("an award knows which money it is", () => {
  // `AWARD_CURRENCY = "NGN"` is gone. A constant here is what stopped the prize
  // reaching anyone outside the home currency.
  it("has no hard-coded award currency left", () => {
    expect(ADMIN).not.toMatch(/const AWARD_CURRENCY\s*=/);
  });

  it("resolves the programme's currency once, and uses it for the posting AND the messages", () => {
    const decide = ADMIN.slice(ADMIN.indexOf("async decide("));
    const body = decide.slice(0, decide.indexOf("\n  async "));
    expect(body).toMatch(/const awardCurrency = awardCurrencyOf\(program\)/);
    // Every figure the family or the log sees is in that currency.
    expect(body).toMatch(/formatMoney\(awardMinor, awardCurrency\)/);
    expect(body).toMatch(/formatMoney\(disbursement\.amountMinor, awardCurrency\)/);
  });

  // A REQUIRED parameter is a search for every caller relying on a default —
  // the trick that found the Paystack currency sites and the payment-approval
  // thresholds. A default here is exactly how the hard-coded NGN survived.
  it("takes the currency as a required parameter on both disbursement paths", () => {
    for (const fn of ["private async disburseFeesCredit(", "private async holdAsCredit("]) {
      const at = ADMIN.indexOf(fn);
      expect(at).toBeGreaterThan(-1);
      const sig = ADMIN.slice(at, ADMIN.indexOf(")", ADMIN.indexOf("awardCurrency", at)));
      expect(sig).toMatch(/awardCurrency: string/);
      expect(sig).not.toMatch(/awardCurrency: string\s*=/);
    }
  });

  // The credit row is STAMPED, never left null: null means "the school's own
  // currency", which is a different claim from "this currency".
  it("stamps the credit ledger row with the award's currency", () => {
    const hold = ADMIN.slice(ADMIN.indexOf("private async holdAsCredit("));
    expect(hold.slice(0, 2500)).toMatch(/currency: awardCurrency/);
  });

  it("refuses a mismatch on both paths rather than converting", () => {
    // There is no FX rate in this platform, and inventing one to clear a
    // family's fees would be worse than refusing.
    expect(ADMIN).toMatch(/if \(invoice\.currency !== awardCurrency\)/);
    expect(ADMIN).toMatch(/if \(schoolCurrency !== awardCurrency\)/);
  });
});

describe("the exam time is one a family can act on", () => {
  it("resolves each school's own clock, once per school", () => {
    const announce = ADMIN.slice(ADMIN.indexOf("async announceExam("));
    const body = announce.slice(0, announce.indexOf("\n  private "));
    expect(body).toMatch(/schoolTimeString\(region\.timezone, program\.examAt\)/);
    // Inside the per-school loop, not the per-candidate one.
    const loopAt = body.indexOf("for (const [schoolId, studentIds] of bySchool)");
    expect(loopAt).toBeGreaterThan(-1);
    expect(body.indexOf("schoolTimeString")).toBeGreaterThan(loopAt);
  });

  it("falls back to a LABELLED utc reading rather than a silently wrong local one", () => {
    const announce = ADMIN.slice(ADMIN.indexOf("async announceExam("));
    const body = announce.slice(0, announce.indexOf("\n  private "));
    expect(body).toMatch(/whenUtc = `\$\{program\.examAt\.toISOString\(\)[^`]*\(UTC\)`/);
    expect(body).toMatch(/let when = whenUtc/);
  });
});

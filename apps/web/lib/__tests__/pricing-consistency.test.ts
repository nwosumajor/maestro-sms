/**
 * PRICING ACCURACY GATE
 * =============================================================================
 * Three assets quote the same commercial facts to school owners:
 *
 *   1. apps/web/app/for-owners/page.tsx  — DERIVES them from @sms/types, so it
 *      cannot drift and is not checked here.
 *   2. docs/ONBOARDING-MANUAL.html       — the leader's manual, served at /manual.
 *   3. docs/SCHOOL_OWNER_PROPOSAL.md     — the proposal sent to prospects.
 *
 * (2) and (3) are static documents. They cannot import a constant, so nothing
 * stops a pricing change in @sms/types from silently making them WRONG — and a
 * proposal that quotes a stale discount is a commitment a prospect will hold you
 * to. This test fails the build in that case, naming the file to update.
 *
 * It asserts PRESENCE of the current value, not absence of the old one: a doc
 * that never discusses a fact is not forced to.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CYCLE_DISCOUNT_PERCENT,
  CYCLE_MONTHS,
  PLANS,
  SUBSCRIPTION_TRIAL_DAYS,
  PAYMENT_APPROVAL_THRESHOLD_MINOR,
} from "@sms/types";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

const MANUAL = "docs/ONBOARDING-MANUAL.html";
const PROPOSAL = "docs/SCHOOL_OWNER_PROPOSAL.md";

/** Naira, from the kobo constant: 5_000_000 -> "50,000". */
const nairaThreshold = (PAYMENT_APPROVAL_THRESHOLD_MINOR / 100).toLocaleString("en-US");

/** Every claim, the doc that makes it, and how to fix a failure. */
const CLAIMS: { file: string; label: string; needle: string }[] = [
  // --- commitment discounts -------------------------------------------------
  { file: MANUAL, label: "per-term discount", needle: `${CYCLE_DISCOUNT_PERCENT.TERM}% off` },
  { file: MANUAL, label: "per-year discount", needle: `${CYCLE_DISCOUNT_PERCENT.YEAR}% off` },
  // --- cycle lengths (a "year" is the ACADEMIC year, not 12 months) ----------
  { file: MANUAL, label: "term length in months", needle: `${CYCLE_MONTHS.TERM} months` },
  { file: MANUAL, label: "academic-year length in months", needle: `${CYCLE_MONTHS.YEAR} months` },
  // --- trial ----------------------------------------------------------------
  { file: PROPOSAL, label: "trial length", needle: `${SUBSCRIPTION_TRIAL_DAYS}-day trial` },
  // --- maker-checker threshold on money -------------------------------------
  { file: MANUAL, label: "payment approval threshold", needle: `₦${nairaThreshold}` },
];

describe("owner-facing documents quote CURRENT pricing", () => {
  it.each(CLAIMS)("$file states the $label", ({ file, needle }) => {
    const body = read(file);
    if (!body.includes(needle)) {
      throw new Error(
        `${file} does not contain "${needle}".\n\n` +
          `A pricing/policy constant in @sms/types changed and this document was not updated.\n` +
          `Fix the wording in ${file}, then — if it is the manual — regenerate the served copy:\n` +
          `    pnpm --filter @sms/web build:manual`,
      );
    }
  });

  it("both documents name every plan tier", () => {
    const manual = read(MANUAL);
    const proposal = read(PROPOSAL);
    for (const plan of Object.keys(PLANS)) {
      // Documents use title case ("Standard"), the constant is SCREAMING_CASE.
      const titled = plan.charAt(0) + plan.slice(1).toLowerCase();
      expect(manual).toContain(titled);
      expect(proposal).toContain(titled);
    }
  });

  it("the served manual is in sync with its source", () => {
    // app/manual/manual-html.ts is GENERATED from the docs file. A stale copy
    // means /manual serves outdated pricing even after the source was fixed.
    const source = read(MANUAL);
    const generated = read("apps/web/app/manual/manual-html.ts");
    const marker = `${CYCLE_DISCOUNT_PERCENT.YEAR}% off`;
    expect(source).toContain(marker);
    if (!generated.includes(marker)) {
      throw new Error(
        "apps/web/app/manual/manual-html.ts is STALE — /manual would serve outdated pricing.\n" +
          "Regenerate it:  pnpm --filter @sms/web build:manual",
      );
    }
  });
});

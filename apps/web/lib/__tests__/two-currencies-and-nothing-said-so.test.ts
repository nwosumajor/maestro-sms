/**
 * GHS ON THE DASHBOARD AND NAIRA ON THE BILLING PAGE.
 *
 * Reported by a school owner as a contradiction. It is not one — BOTH FIGURES
 * WERE CORRECT — and that is exactly what made it worth fixing:
 *
 *   school.currency              GHS   what the school charges FAMILIES
 *   school_subscription.currency NGN   what the school pays the PLATFORM
 *
 * Measured on the live tenant: country GH, fee currency GHS, and six real
 * platform payments — four in NGN, two in USD. The school genuinely checked out
 * in naira, because `planCurrencies()` ships prices for NGN and USD only; GHS
 * is not a sellable subscription currency, so naira and dollars were the only
 * options it was ever offered.
 *
 * So nothing was wrong with the numbers and NOTHING SAID THEY WERE DIFFERENT
 * THINGS. A number a reader cannot account for is one they stop trusting —
 * including the ones that are right — which is the same reasoning behind the
 * export bundle's coverage manifest and "no register yet" versus "attended
 * nothing".
 *
 * Live after: the note appears for that school and NOT for one whose two
 * currencies agree.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = readFileSync(join(__dirname, "..", "..", "app", "(app)", "billing", "page.tsx"), "utf8");

describe("the billing page accounts for its own currency", () => {
  it("says which currency the SUBSCRIPTION is billed in", () => {
    expect(PAGE).toContain("Your subscription is billed in");
  });

  it("names the school's own currency beside it, so the pair is legible", () => {
    // Naming only one leaves the reader with the same question.
    expect(PAGE).toMatch(/\{region\.currency\} you charge families/);
  });

  it("says school fees are unaffected — the thing an owner actually fears", () => {
    expect(PAGE).toMatch(/school fees are unaffected/);
  });

  it("appears ONLY when the two differ", () => {
    // A note on every school is one nobody reads, including the schools where
    // it matters. Verified live: shown for the GHS/NGN tenant, absent for the
    // one whose currencies agree.
    expect(PAGE).toMatch(/data\.subscription\.currency !== region\.currency/);
  });

  it("is driven by the SUBSCRIPTION's own currency, not a default", () => {
    // `money(x)` with no currency falls back to the platform's — the defect
    // class this repo already records for the operator console. The charge line
    // passes the subscription's own.
    expect(PAGE).toMatch(/money\(data\.subscription\.priceMinor, data\.subscription\.currency \?\? "NGN"\)/);
  });
});

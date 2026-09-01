// =============================================================================
// The remittance file that divided by a hundred
// =============================================================================
// CLAUDE.md states the rule plainly: money is scaled by the CURRENCY, never by
// 100 — right for NGN, GHS, KES, ZAR, USD and GBP, and 100× WRONG for the CFA
// franc and every other zero-decimal currency, which is eleven of the
// twenty-nine African countries in the catalogue.
//
// `bankExport` follows it: `toMajor(minor, currency)` then
// `toFixed(currencyDecimals(currency))`. `remittanceExport`, the method
// immediately below it, carried its own
//
//   const money = (m: number) => (m / 100).toFixed(2);
//
// and that file is the one filed with a REVENUE AUTHORITY and a pension
// administrator: gross pay, PAYE and pension per employee. In a zero-decimal
// currency every figure on it would be a hundredth of the truth.
//
// LATENT, NOT LIVE, and worth saying so: PAYROLL_PACKS implements NG and GB
// only, and createRun refuses a country without a pack, so no zero-decimal
// school can reach this today. It would have gone wrong silently on the day one
// was added — which is the worst moment to discover it, because the first
// evidence is a filing somebody has already made.
// =============================================================================

import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";
import { currencyDecimals, toMajor, formatMoney, PAYROLL_PACKS } from "@sms/types";

const SRC = readFileSync(join(__dirname, "../../src/hr/payroll.service.ts"), "utf8");

/**
 * The body of ONE method. A fixed-size window reaches into the next method and
 * borrows its evidence: reverting the fix still "passed" the first time, because
 * a neighbour happened to use toMajor a few hundred characters further down.
 */
function body(method: string): string {
  const from = SRC.indexOf(`async ${method}(`);
  if (from === -1) throw new Error(`no method ${method} in payroll.service.ts`);
  const next = SRC.indexOf("\n  async ", from);
  return stripComments(SRC.slice(from, next === -1 ? SRC.length : next));
}

/**
 * Comments out. Both of these methods carry a comment QUOTING the defect they
 * were fixed for — `it carried a hard-coded "Net (NGN)" header` — and a scan
 * that reads prose fails on the explanation of the fix. Made this mistake twice
 * before in this repo; see the assertions-that-match-by-accident gate.
 */

describe("what the exports do to a minor-unit amount", () => {
  it("scales by the currency, in BOTH exports", () => {
    for (const method of ["bankExport", "remittanceExport"]) {
      expect([method, /toMajor\(/.test(body(method))]).toEqual([method, true]);
      expect([method, /currencyDecimals\(/.test(body(method))]).toEqual([method, true]);
    }
  });

  it("no longer assumes two decimal places in either of them", () => {
    for (const method of ["bankExport", "remittanceExport"]) {
      expect(body(method)).not.toMatch(/\(m \/ 100\)/);
    }
  });
});

describe("what the exports CALL the money", () => {
  it("names the school's currency in every column header, in both exports", () => {
    // Getting the figures right and heading the column "Gross (NGN)" produces a
    // filing that states the wrong currency, and on a statutory return the
    // number and its unit are read together. The remittance headers were three
    // hard-coded strings carrying six "(NGN)" between them.
    for (const method of ["bankExport", "remittanceExport"]) {
      expect([method, body(method)]).not.toEqual([method, expect.stringContaining("(NGN)")]);
    }
  });

  it("interpolates it rather than hard-coding any currency", () => {
    const b = body("remittanceExport");
    expect(b).toMatch(/Gross \(\$\{cur\}\)/);
    expect(body("bankExport")).toMatch(/Net \(\$\{region\.currency\}\)/);
  });
});

describe("the fallback that could not run", () => {
  it("no longer exists, so no arm of the payslip formatter divides by 100", () => {
    // formatMoney cannot throw — an unknown currency or locale falls back
    // INSIDE it, still scaled by the currency. The catch wrapped around it here
    // was unreachable, and its body was the one arm that would have been wrong.
    expect(stripComments(SRC)).not.toMatch(/\/ 100/);
  });

  it("and formatMoney really does absorb an unknown currency itself", () => {
    // The claim the deletion rests on, checked rather than assumed.
    expect(() => formatMoney(150000, "ZZZ", "en")).not.toThrow();
    expect(formatMoney(150000, "ZZZ", "en")).toContain("ZZZ");
    expect(() => formatMoney(150000, "NGN", "not-a-locale")).not.toThrow();
  });
});

describe("why it matters, in numbers", () => {
  it("a zero-decimal currency is not divided at all", () => {
    // XOF has no minor unit: 5,000 francs is stored as 5000 and IS 5,000.
    expect(toMajor(5000, "XOF")).toBe(5000);
    expect(currencyDecimals("XOF")).toBe(0);
    // What the old line would have filed instead:
    expect((5000 / 100).toFixed(2)).toBe("50.00");
  });

  it("and a two-decimal one still is", () => {
    // The fix must not break the currencies that were right all along.
    expect(toMajor(500000, "NGN")).toBe(5000);
    expect(currencyDecimals("NGN")).toBe(2);
  });
});

describe("how far the exposure reaches today", () => {
  it("is latent: only two-decimal countries have a payroll pack", () => {
    // The claim in the comment, checked rather than asserted in prose — if a
    // zero-decimal pack is added, this fails and points at the exports.
    for (const key of Object.keys(PAYROLL_PACKS)) {
      const currency = key === "NG" ? "NGN" : "GBP";
      expect([key, currencyDecimals(currency)]).toEqual([key, 2]);
    }
  });
});

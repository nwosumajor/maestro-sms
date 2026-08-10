// =============================================================================
// Money is formatted by the currency, never by dividing by 100
// =============================================================================
// CLAUDE.md records this defect class as fixed — a CFA-franc receipt printing
// at a hundredth of its value. It was, in ONE place. Seven others were still
// dividing by 100 by hand, including the two that matter most:
//
//   * the parent fee RECEIPT PDF — the one document every payer keeps
//   * the payroll BANK EXPORT — not a display at all, but the file a bursar
//     uploads to actually pay staff, with a hard-coded "Net (NGN)" header
//
// Eleven of the twenty-nine currencies in the catalogue are zero-decimal, so in
// those the stored minor unit IS the major unit. Dividing by 100 there does not
// merely misprint a receipt — in the bank export it would have paid every staff
// member a hundredth of their salary.
//
// The behavioural cases come first; the source guard exists because the defect
// keeps coming back as a hand-rolled Intl.NumberFormat somewhere new.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { currencyDecimals, formatMoney, toMajor } from "@sms/types";

describe("formatMoney across decimal and zero-decimal currencies", () => {
  it("scales a TWO-decimal currency by 100", () => {
    expect(formatMoney(320_981_250, "NGN")).toContain("3,209,812.50");
  });

  it("does NOT scale a ZERO-decimal currency", () => {
    // XOF has no minor unit: 5000 stored is 5000 francs, not 50.
    expect(toMajor(5_000, "XOF")).toBe(5_000);
    expect(currencyDecimals("XOF")).toBe(0);
    const out = formatMoney(5_000, "XOF");
    expect(out).toContain("5,000");
    expect(out).not.toContain("50.00");
  });

  it("is the difference between a correct payslip and a 100x wrong one", () => {
    // The bank-export case, stated as arithmetic: a naive /100 on a
    // zero-decimal salary underpays by two orders of magnitude.
    const storedMinor = 450_000;
    expect(toMajor(storedMinor, "XOF")).toBe(450_000);
    expect(storedMinor / 100).toBe(4_500); // what the old code would have paid
  });

  it("renders an unknown currency rather than going blank", () => {
    // A receipt with no amount on it is worse than one with an odd symbol.
    expect(formatMoney(1234, "ZZZ")).toMatch(/1234|12\.34/);
  });
});

// --- the source guard ------------------------------------------------------ //

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

describe("no hand-rolled money formatting", () => {
  const files = sourceFiles(join(__dirname, "../../src"));

  it("never builds a currency string with Intl.NumberFormat directly", () => {
    // formatMoney already wraps Intl and asks the currency how many minor units
    // it has. Every hand-rolled one so far has hard-coded two, and three of them
    // hard-coded en-NG and a naira symbol on top.
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (/new Intl\.NumberFormat\([^)]*\)[\s\S]{0,80}?style:\s*"currency"/.test(src)) {
        offenders.push(file.split("/src/")[1]);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never divides a minor-unit figure by 100 to display or export it", () => {
    // Scoped to the money paths — `/ 100` is legitimate for percentages and
    // HSL colour maths elsewhere, so this looks for it beside a money name.
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const line of src.split("\n")) {
        const code = line.trim();
        // Comments describe the defect; they are not the defect. Several of
        // them say "never minor/100" precisely because it used to be there.
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
        if (!/\/\s*100\b/.test(line)) continue;
        if (!/Minor|amount|net|salary|price|total/i.test(line)) continue;
        // `score / total * 100` is a percentage, not money.
        if (/percent|ratio|basis|bp\b|\* 100/i.test(line)) continue;
        offenders.push(`${file.split("/src/")[1]} :: ${line.trim().slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

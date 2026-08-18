// =============================================================================
// A school's chart shows a school's money
// =============================================================================
// The analytics Fees chart divided minor units by 100 and prefixed a hard-coded
// ₦. Two independent errors pointing the same way:
//
//   - /100 is right for the naira and wrong for every ZERO-DECIMAL currency —
//     the CFA franc among them, which covers 11 of the catalogued African
//     countries. A Senegalese school invoicing XOF 500,000 saw a bar reading
//     5,000: a hundredth of the truth, on the screen a principal uses to judge
//     whether fees are being collected.
//   - the ₦ meant every school's money was labelled in naira regardless.
//
// The value now converts with toMajor(minor, currency) and the currency travels
// with it from the SESSION — the school's, never the platform's.
// =============================================================================

import { toMajor, isZeroDecimal, minorUnits } from "@sms/types";
import { fmtVal, nfCompact } from "../../components/charts/format-value";

describe("converting a stored amount for a chart", () => {
  it("is a straight division for a two-decimal currency", () => {
    expect(toMajor(500_000, "NGN")).toBe(5_000);
    expect(toMajor(500_000, "GHS")).toBe(5_000);
  });

  it("does NOT divide a zero-decimal currency", () => {
    // The whole defect in one line: /100 would say 5,000.
    // minorUnits is the DIVISOR — 100 for the naira, 1 for a currency with no
    // subdivision — so the semantic check is isZeroDecimal.
    expect(isZeroDecimal("XOF")).toBe(true);
    expect(minorUnits("XOF")).toBe(1);
    expect(toMajor(500_000, "XOF")).toBe(500_000);
  });
});

describe("labelling it", () => {
  it("uses the school's currency, not the platform's", () => {
    const ghs = fmtVal(500_000, true, "GHS", "en-GH");
    expect(ghs).not.toContain("₦");
    expect(ghs).toMatch(/GH|₵/);
  });

  it("labels naira as naira when that IS the school's currency", () => {
    expect(fmtVal(5_000, true, "NGN", "en-NG")).toMatch(/₦|NGN/);
  });

  it("keeps a CFA amount at its real magnitude", () => {
    // 500,000 XOF must read as half a million, not five thousand.
    const out = fmtVal(toMajor(500_000, "XOF"), true, "XOF", "fr-SN");
    expect(out).toMatch(/500/);
  });

  it("degrades to a readable number for an unrecognised code", () => {
    // school.currency is a free-form ISO column; a bad value must not blank the
    // chart or throw inside a render.
    expect(() => fmtVal(1_500, true, "NOTACODE")).not.toThrow();
    expect(fmtVal(1_500, true, "NOTACODE")).toContain("1.5k");
  });

  it("leaves non-money values alone", () => {
    expect(fmtVal(1234, false)).toBe((1234).toLocaleString());
  });

  it("still compacts axis numbers", () => {
    expect(nfCompact(1000)).toBe("1k");
    expect(nfCompact(1500)).toBe("1.5k");
    expect(nfCompact(999)).toBe("999");
  });
});

describe("the page that draws it", () => {
  it("converts by currency and passes the school's region to the chart", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const page = readFileSync(join(__dirname, "../../app/(app)/analytics/page.tsx"), "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(page).toMatch(/toMajor\(fees\.invoicedMinor, region\.currency\)/);
    expect(page).toMatch(/currency=\{region\.currency\}/);
    // The thing that was there before must not come back.
    expect(page).not.toMatch(/Minor \/ 100|invoicedMinor \/ 100/);
  });

  it("no chart hard-codes a currency symbol", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // Comments stripped: the note explaining this fix names the symbol, and an
    // assertion that matches its own documentation proves nothing.
    const rc = readFileSync(join(__dirname, "../../components/charts/rc.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(rc).not.toContain("₦");
    // And no chart may format money without being told whose it is.
    expect(rc).not.toMatch(/nfCompact\((?:total|d\.value)\)/);
  });
});

// =============================================================================
// A broken bar where the naira should be
// =============================================================================
// pdfkit's built-in fonts are WinAnsi — one byte per character — and `₦` is
// U+20A6, which WinAnsi has no room for. pdfkit silently wrote its LOW BYTE,
// 0xA6, the BROKEN BAR. Verified by decoding a real payslip's content stream:
// bytes `20 A6 32 30 30` — so a Nigerian school handed an employee a payslip
// reading `¦200,000.00`, and handed a parent a fee receipt the same way.
//
// NOT ONLY THE NAIRA. The CFA franc renders `F CFA` with a NARROW NO-BREAK
// SPACE (U+202F) in every locale — eleven of the catalogue's African countries
// — and a French locale uses U+202F as the GROUPING separator for every
// currency, so a francophone school's documents broke whatever it billed in.
//
// The three documents that carry money out of the building: the fee receipt a
// parent keeps, the payslip an employee is given, and the subscription receipt.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatMoney, formatMoneyPdf, toWinAnsi } from "@sms/types";

const SRC = join(__dirname, "..", "..", "src");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Exactly what a pdfkit standard font can put on a page. */
const encodable = (s: string) =>
  [...s].every((ch) => {
    const cp = ch.codePointAt(0)!;
    return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa1 && cp <= 0xff);
  });

// The catalogue's currencies against the locales a school in that market runs.
const CASES: Array<[string, string]> = [
  ["en-NG", "NGN"],
  ["en-GH", "GHS"],
  ["en-KE", "KES"],
  ["en-ZA", "ZAR"],
  ["en-GB", "GBP"],
  ["en-US", "USD"],
  ["fr-SN", "XOF"],
  ["fr-CI", "XOF"],
  ["fr-CM", "XAF"],
  ["en", "NGN"],
];

describe("money on a printed document", () => {
  it("is renderable by a standard PDF font, for every market", () => {
    const broken = CASES.filter(([loc, cur]) => !encodable(formatMoneyPdf(123_456_78, cur, loc)));
    expect(broken).toEqual([]);
  });

  it("proves the bug it replaces — the SYMBOL form is not renderable", () => {
    // Without this the test above could pass for a formatter that changed
    // nothing, and the reason for the change would be unrecorded.
    expect(encodable(formatMoney(20_000_000, "NGN", "en-NG"))).toBe(false);
    expect(formatMoney(20_000_000, "NGN", "en-NG")).toContain("₦");
    expect(formatMoneyPdf(20_000_000, "NGN", "en-NG")).toBe("NGN 200,000.00");
  });

  it("keeps the school's OWN number formatting", () => {
    // A French school keeps `1 234,50`; the fix is about the glyph, not about
    // pushing every market into English conventions.
    expect(formatMoneyPdf(123_450, "XOF", "fr-SN")).toMatch(/123 450|123450/);
  });

  it("never divides by 100 — a zero-decimal currency is unchanged", () => {
    // The rule the receipt already carried: the CFA franc has no minor unit.
    expect(formatMoneyPdf(5000, "XOF", "fr-SN")).toMatch(/5 ?000/);
    expect(formatMoneyPdf(5000, "NGN", "en-NG")).toBe("NGN 50.00");
  });

  it("whitelists, so a new locale cannot introduce a new broken glyph", () => {
    // Anything unrecognised becomes a plain space — wrong-looking at worst,
    // never a different character that reads as data.
    expect(toWinAnsi("a⁠b c−d一e")).toBe("a b c-d e");
  });
});

describe("the documents that carry money out of the building", () => {
  it.each([
    ["fees/fee-ops.service.ts", "the fee receipt a parent keeps"],
    ["hr/payroll.service.ts", "the payslip an employee is given"],
    ["billing/billing.service.ts", "the subscription receipt"],
  ])("%s uses the PDF-safe formatter — %s", (rel) => {
    const src = strip(readFileSync(join(SRC, rel), "utf8"));
    // The PDF builder in each of these must not reach for the symbol form.
    // Anchored to the FACTORY, not to `new PDFDocument(` — that literal was
    // replaced by `createPdfDocument` when the text fold moved to the pdfkit
    // boundary, and this assertion went red over a change that strengthened the
    // property it guards. The fixed-text failure mode, again.
    const at = src.indexOf("createPdfDocument(");
    expect(at).toBeGreaterThan(-1);
    expect(src).toContain("formatMoneyPdf(");
  });
});

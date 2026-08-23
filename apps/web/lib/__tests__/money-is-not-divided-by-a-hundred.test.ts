// =============================================================================
// The web knew the currency and still multiplied by a hundred
// =============================================================================
// `packages/types/src/currency.ts` says it plainly, and CLAUDE.md repeats it:
// money is scaled by the CURRENCY, never by 100. Right for NGN, GHS, KES, ZAR,
// USD and GBP; a hundredfold error for the CFA franc and every other
// zero-decimal currency — eleven of the twenty-nine African countries in the
// catalogue.
//
// An earlier pass fixed the READING half. Components were given `useFormat()`
// and comments saying "the SCHOOL's currency and locale, not the platform's".
// The WRITING half was left exactly as it was, so several components displayed
// a school's francs correctly and, two lines below, sent the API a hundred
// times what the bursar had typed:
//
//   const { money } = useFormat();                      // correct
//   const minor = Math.round(Number(amount) * 100);     // not
//
// Reading is a wrong number on a screen. Writing is a wrong number on an
// invoice, a payslip, a staff loan or a late-fee policy. Fourteen sites: salary
// changes, employee salary, staff loans, loan repayments, fee items, invoice
// lines, adjustments, credits, instalment plans, late fees, admission-form
// fees, transport costs, and the public directory — which had no session to
// read a region from and so hard-coded `en-NG`/`NGN` for every school on the
// platform.
//
// This gate reads the source, because the defect is invisible to the type
// system: `number * 100` is a perfectly well-typed number.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "../..");

/**
 * Sites where a literal 100 is CORRECT, each with the reason.
 *
 * Kept as an explicit list rather than a clever exemption rule: a rule that
 * decides for itself what is platform money would quietly absorb the next
 * tenant-money site that looks similar.
 */
const ALLOWED: Record<string, string> = {
  // Basis points are hundredths BY DEFINITION — not money being scaled.
  "components/operator/GrowthManager.tsx": "commissionBp / 100 converts basis points to a percentage",
  "components/operator/PlatformFeeManager.tsx": "platform fees are quoted and stored in the platform's own NGN",
  "components/operator/PricingManager.tsx": "plan prices are the platform's own billing, per stated currency",
  "components/operator/PlatformAnalytics.tsx": "platform revenue chart, platform currency",
  "components/operator/AttentionQueue.tsx": "platform revenue at a glance, platform currency",
  "components/billing/TrueUpCard.tsx": "subscription billing is the platform's own, NGN or USD",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === "dist" || e === "__tests__") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.tsx?$/.test(f)) out.push(f);
  }
  return out;
}

/** Comments out: several of these files EXPLAIN the defect they were fixed for,
 *  and a scan that reads prose fails on the explanation of its own fix. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** A line that scales MONEY by a literal 100, in either direction. */
const MONEY_WORD = /minor|amount|price|fee|money|kobo|salary|cost|balance|total|credit|charge|pay/i;
const SCALES_BY_100 = /(\*\s*100\b|\/\s*100\b)/;

describe("every place the web turns money into minor units, or back", () => {
  const offenders: string[] = [];
  let scanned = 0;

  for (const file of [...walk(join(WEB, "components")), ...walk(join(WEB, "app")), ...walk(join(WEB, "lib"))]) {
    const rel = file.slice(WEB.length + 1);
    if (rel in ALLOWED) continue;
    scanned += 1;
    for (const [i, line] of stripComments(readFileSync(file, "utf8")).split("\n").entries()) {
      if (!SCALES_BY_100.test(line)) continue;
      if (!MONEY_WORD.test(line)) continue;
      // A PERCENTAGE is a ratio, not a rescale: `Math.round((done / total) * 100)`
      // scales a fraction into 0-100 and never touches minor units. Recognised by
      // the `x / y * 100` shape and by what the result is called — both, because
      // either alone lets a real money line through.
      if (/%|percent|\bpct\b|\bbp\b|Bp\b|\brate\b|\bshare\b/i.test(line)) continue;
      if (/\/\s*\w+\s*\)?\s*\*\s*100\b/.test(line)) continue;
      offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    }
  }

  it("asks the currency instead of assuming a hundredth", () => {
    expect(offenders).toEqual([]);
  });

  it("actually read the files", () => {
    // A walker that silently matched nothing would pass for ever.
    expect(scanned).toBeGreaterThan(100);
  });
});

describe("the helper that was missing", () => {
  it("scales an entered amount by the currency, not by 100", async () => {
    const { minorFrom, majorFrom } = await import("../format");
    // Two-decimal: unchanged behaviour for every school already live.
    expect(minorFrom("1500.50", "NGN")).toBe(150050);
    expect(majorFrom(150050, "NGN")).toBe(1500.5);
    // Zero-decimal: 5,000 francs IS 5,000 minor units. `* 100` stored 500,000.
    expect(minorFrom("5000", "XOF")).toBe(5000);
    expect(majorFrom(5000, "XOF")).toBe(5000);
  });

  it("treats an empty or unparseable box as nothing, never as NaN", () => {
    // A NaN reaching the API is a 500 or, worse, a null amount on an invoice.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { minorFrom } = require("../format") as typeof import("../format");
    expect(minorFrom("", "NGN")).toBe(0);
    expect(minorFrom("abc", "NGN")).toBe(0);
  });
});

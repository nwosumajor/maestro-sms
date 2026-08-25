// =============================================================================
// Money at the DB boundary — the columns are BIGINT, so nothing may leak one
// =============================================================================
// Prisma maps int8 to a JavaScript `bigint`, which THROWS inside
// JSON.stringify. A bigint that reaches a response is not a wrong number, it is
// a 500 on a page that used to work — and the typechecker cannot see it through
// a cast.
//
// That is not hypothetical: widening the columns broke /operator/payments, and
// it broke there and nowhere else precisely BECAUSE that service had an
// `as unknown as` cast around Prisma's groupBy overload. The cast that made the
// call compile also switched off the check that would have caught this.
//
// So there are two guards here: the conversion helper's own behaviour, and a
// source scan for the fields that must always cross through it.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { toMinor, toMinorOrNull } from "../../src/common/money";

describe("toMinor", () => {
  it("scanned something — this gate can otherwise pass by finding nothing", () => {
    // THE FAILURE EVERY SOURCE-SCANNING GATE SHARES. The check above asserts an
    // EMPTY offender list, so a walk that returns no files passes with a green
    // tick while covering nothing at all — a moved directory, a changed
    // extension, a renamed root. Demonstrated on this repo by pointing one
    // gate's walk at a directory holding no `.ts` files: every assertion still
    // passed. The magnitude is the only thing that can tell "clean" from "blind".
    expect(sourceFiles(join(__dirname, "../../src")).length).toBeGreaterThan(100);
  });

  it("converts a bigint from the database to a plain number", () => {
    expect(toMinor(BigInt(320_981_250))).toBe(320_981_250);
  });

  it("passes a number straight through", () => {
    // So a call site does not need to know whether its column has been widened
    // yet — which is what keeps a partial migration safe.
    expect(toMinor(1234)).toBe(1234);
  });

  it("treats null as the fallback, not as a crash", () => {
    expect(toMinor(null)).toBe(0);
    expect(toMinor(undefined)).toBe(0);
    expect(toMinor(null, 42)).toBe(42);
  });

  it("keeps null DISTINCT from zero where that matters", () => {
    // A subscription never charged has no price; it does not have a price of
    // nothing. Collapsing the two would quote a free renewal.
    expect(toMinorOrNull(null)).toBeNull();
    expect(toMinorOrNull(BigInt(0))).toBe(0);
  });

  it("REFUSES a figure a double cannot hold exactly", () => {
    // Silently rounding money is the exact defect this widening removes, and it
    // would be far harder to notice than the 500 the int4 ceiling used to throw.
    expect(() => toMinor(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(10))).toThrow(/too large/i);
  });

  it("accepts the largest value it can still represent exactly", () => {
    expect(toMinor(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("survives a round trip at a realistic multi-year charge", () => {
    // 5,000 pupils x 5 academic years — the case that used to overflow int4.
    const big = BigInt(21_515_625_000);
    expect(toMinor(big)).toBe(21_515_625_000);
    expect(JSON.stringify({ amountMinor: toMinor(big) })).toContain("21515625000");
  });
});

// --- the source guard ------------------------------------------------------ //

/** Fields backed by a BIGINT column. Reading one yields a bigint. */
const BIGINT_FIELDS = [
  "amountMinor",
  "arrearsMinor",
  "priceMinor",
  "seatArrearsMinor",
  "totalGrossMinor",
  "totalNetMinor",
  "budgetMinor",
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

describe("no cast may smuggle a bigint past the typechecker", () => {
  it("never asserts a BIGINT-backed field is a number", () => {
    // `x.amountMinor as number` compiles and then throws at serialisation. This
    // is the shape that broke /operator/payments; the fix is toMinor(), which
    // is checked. Named files so a failure says exactly where to look.
    //
    // COMMENTS STRIPPED FIRST. A scan that reads prose fails on the explanation
    // of its own rule: a file that documents why it does NOT write
    // `.amountMinor as number` was reported as writing it. Its sibling
    // `money-is-not-divided-by-a-hundred` already strips them and says why —
    // this one did not, and went red on a comment.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const offenders: string[] = [];
    for (const file of sourceFiles(join(__dirname, "../../src"))) {
      const src = stripComments(readFileSync(file, "utf8"));
      for (const field of BIGINT_FIELDS) {
        // `(row.amountMinor as number)` — an assertion straight to number.
        const bad = new RegExp(`\\.${field}\\s+as\\s+number\\b`);
        if (bad.test(src)) offenders.push(`${file.split("/src/")[1]} :: ${field} as number`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the conversion in ONE place, so there is one thing to get right", () => {
    const money = readFileSync(join(__dirname, "../../src/common/money.ts"), "utf8");
    expect(money).toContain("MAX_SAFE_INTEGER");
    // The guard must THROW rather than log-and-continue: a rounded figure that
    // reaches a ledger is worse than a failed request.
    expect(money).toMatch(/throw new Error/);
  });
});

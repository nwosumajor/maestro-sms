// =============================================================================
// Every write to the credit ledger names its currency
// =============================================================================
// `student_credit_entry.deltaMinor` is a number of minor units. Which minor
// units it is comes from OUTSIDE the ledger — the source invoice's currency for
// an overpayment, the charge's for a dedicated-account transfer, the target
// invoice's for an application — so a writer that omits it is not merely
// under-recording, it is putting a figure into a total that spends it as
// something else. Measured live before the column existed: $100.00 of
// overpayment became a credit of 10,000 and went onto a naira bill as ₦100.
//
// The defect was NOT that nobody had thought about it. `initPrepay` raises its
// charge in the school's own currency and says why in a comment. One producer
// of four, and neither consumer — the shape this repo keeps finding, and the
// reason this is a gate rather than four fixed call sites.
//
// It asks about the WRITE, not the read: a read that forgets the currency
// renders a wrong symbol, which is bad; a WRITE that forgets it destroys the
// fact for ever, and no later reader can recover it.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "../../src");

/**
 * A write that deliberately does not name a currency, with the reason. Empty
 * today, and kept so that the next one has to be argued for in writing rather
 * than merged as an oversight.
 */
const ALLOWED: Record<string, string> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".ts") && !f.endsWith(".spec.ts")) out.push(f);
  }
  return out;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Each `studentCreditEntry.create({...})` call, as its own `data` block. */
function creditWrites(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/studentCreditEntry\.(?:create|createMany|upsert)\s*\(/g)) {
    // Read to the matching close paren rather than a fixed window: a data block
    // runs to whatever length its comments and fields need, and a character
    // count would silently start missing the currency line the day one grew.
    const from = m.index! + m[0].length - 1;
    let depth = 0;
    let end = from;
    for (let i = from; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out.push(src.slice(from, end + 1));
  }
  return out;
}

describe("every writer of a student credit entry", () => {
  const writes: Array<{ where: string; block: string }> = [];

  for (const file of walk(API_SRC)) {
    const rel = file.slice(API_SRC.length + 1);
    const src = stripComments(readFileSync(file, "utf8"));
    for (const block of creditWrites(src)) writes.push({ where: rel, block });
  }

  it("found the writers at all — the scan has not silently broken", () => {
    // A walk that finds nothing produces no offenders and passes covering
    // nothing. There are four producers: prepay, dedicated-account transfer,
    // overpayment move, and the negative row an application writes.
    expect(writes.length).toBeGreaterThanOrEqual(4);
  });

  it("names the currency, or is exempted by name with a reason", () => {
    const silent = writes.filter((w) => !(w.where in ALLOWED) && !/\bcurrency\b/.test(w.block)).map((w) => w.where);
    expect(silent).toEqual([]);
  });

  it("gives every exemption a real reason, not a shrug", () => {
    for (const [where, why] of Object.entries(ALLOWED)) {
      expect([where, why.length > 60]).toEqual([where, true]);
      expect([where, writes.some((w) => w.where === where)]).toEqual([where, true]);
    }
  });
});

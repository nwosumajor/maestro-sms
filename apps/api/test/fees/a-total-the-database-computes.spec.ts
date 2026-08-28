// =============================================================================
// An invoice total the DATABASE computes, never one carried from an old read
// =============================================================================
// `decideAdjustment` states the rule in full:
//
//   "DECREMENT, never assign a total computed from an earlier read. ... two
//    DIFFERENT adjustments on the same invoice ... would both compute
//    `inv.totalMinor - amount` from the same starting figure and one would be
//    lost. The database does the arithmetic, so neither can be."
//
// Six paths mutate an existing invoice's total: an approved discount or waiver,
// a library fine, hostel rent, a transport fare, and the late-fee sweep. Five
// used `{ increment }` / `{ decrement }`. The SWEEP assigned
// `inv.totalMinor + school.lateFeeFlatMinor`, where `inv` comes from a batch
// read of up to 500 invoices taken BEFORE the per-invoice loop.
//
// The same block already knew that read was stale — it re-checks the late-fee
// MARKER inside the writing transaction and says why ("the read above is a
// separate snapshot"). The idempotency concern was handled and the arithmetic
// concern, written down 290 lines above, was not.
//
// WHAT THE LOST WRITE COSTS is worse than the money: assigning `stale + fee`
// over an approved DISCOUNT silently REVERSES a maker-checker decision. The
// `invoice_adjustment` row still reads APPROVED, the audit trail shows only a
// late fee, and the family is billed what the school formally agreed to waive.
//
// LATENT, not observed live: it needs a concurrent write inside the window, and
// the demo school has one late-fee sweep and no contention. It was found by
// reconciling the database — an invoice whose header disagreed with the sum of
// its line items — which is exactly the state this race produces.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

describe("an invoice total is never assigned from an earlier read", () => {
  const files = sourceFiles(join(__dirname, "../../src"));

  it("scanned a believable number of sources", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no write assigns a total derived from a `.totalMinor` already in hand", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.split("/src/")[1];
      const src = readFileSync(file, "utf8").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      // `totalMinor:` followed by an expression that reads a totalMinor — i.e.
      // arithmetic done in Node over a value fetched earlier. An atomic
      // `{ increment: x }` never mentions it, and a CREATE assigns a literal or
      // a freshly-summed local.
      for (const m of src.matchAll(/totalMinor:\s*([^,\n}]+)/g)) {
        const expr = m[1];
        if (/\.totalMinor/.test(expr)) {
          const line = src.slice(0, m.index ?? 0).split("\n").length;
          offenders.push(`${rel}:${line} -> totalMinor: ${expr.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the paths that mutate a total all hand the arithmetic to the database", () => {
    // Named, because an empty offender list also passes against code that
    // stopped updating totals at all.
    const MUTATORS: Array<[string, RegExp]> = [
      ["fees/fee-ops.service.ts", /totalMinor:\s*\{\s*decrement:/],
      ["fees/fee-ops.service.ts", /totalMinor:\s*\{\s*increment:/],
      ["library/library.service.ts", /totalMinor:\s*\{\s*increment:/],
      ["hostel/hostel.service.ts", /totalMinor:\s*\{\s*increment:/],
      ["transport/transport.service.ts", /totalMinor:\s*\{\s*increment:/],
    ];
    for (const [rel, re] of MUTATORS) {
      const src = readFileSync(join(__dirname, "../../src", rel), "utf8");
      expect({ rel, atomic: re.test(src) }).toEqual({ rel, atomic: true });
    }
  });
});

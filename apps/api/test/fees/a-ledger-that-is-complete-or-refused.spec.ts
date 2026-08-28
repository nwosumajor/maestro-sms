// =============================================================================
// A ledger that is complete, or refused — never quietly short
// =============================================================================
// `journalCsv` read `take: 10_000` and said nothing about it. The journal is the
// artifact an accountant imports into a ledger, so a file that is quietly
// 10,000 rows long when the period holds more is a reconciliation that balances
// against the wrong figure — and nothing in the CSV, the filename or the
// download says a row was dropped.
//
// The cap is REACHABLE, not theoretical. Measured on a decade of a 1,000-pupil
// school (120,019 posted payments seeded, then removed):
//
//   a YEAR   12,063 payments  -> old: a silent 10,000-row CSV
//                               new: 400 naming the count and the fix
//   a MONTH     998 payments  -> 200, 999 lines (header + every payment)
//
// The late-fee sweep 230 lines up in the SAME FILE already states the rule:
// "NO SILENT CAP: a truncated sweep that looks complete is how a backlog
// hides", and it warns when it hits its own limit. The finance export did not.
//
// REFUSED RATHER THAN TRUNCATED, deliberately. A short ledger cannot be
// recovered from by the person reading it, because nothing tells them to look.
// A refusal naming the count and the narrower range is actionable in the moment.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/fees/fee-ops.service.ts"), "utf8");
// Bounded by the method, not by a character count — a fixed-size window is how
// a gate silently stops covering the thing it names, which this repo has
// recorded for a decorator run and for a 200-character lookbehind.
const journal = () => {
  const start = SRC.indexOf("async journalCsv");
  const end = SRC.indexOf("const header = [", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
};

describe("the journal export", () => {
  it("was found in the source at all", () => {
    expect(SRC.indexOf("async journalCsv")).toBeGreaterThan(0);
  });

  it("reads ONE PAST the cap, so an overflow is detected rather than delivered", () => {
    // `take: CAP` cannot tell "exactly 10,000 payments" from "more than
    // 10,000", and those are different files.
    expect(journal()).toMatch(/take:\s*FeeOpsService\.JOURNAL_ROW_CAP \+ 1/);
    expect(journal()).not.toMatch(/take:\s*10_000\s*,/);
  });

  it("refuses on overflow, and the refusal names the real count and the way out", () => {
    const block = journal();
    expect(block).toMatch(/pays\.length > FeeOpsService\.JOURNAL_ROW_CAP/);
    expect(block).toMatch(/payment\.count/);
    expect(block).toMatch(/BadRequestException/);
    // Actionable, not just "too many": the accountant needs to know what to do.
    expect(block).toMatch(/narrower ranges/i);
  });

  it("still signs a refund negative and carries the currency", () => {
    // The half that must not be traded away while changing the read: a journal
    // read into a ledger needs the sign and the currency, and both were already
    // right.
    expect(journal()).toMatch(/kind === "REFUND" \? -x\.amountMinor/);
    expect(journal()).toMatch(/currency: x\.invoice\.currency/);
  });
});

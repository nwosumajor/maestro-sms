// =============================================================================
// A NGN 2,500 policy that charged a family USD 2,500.00
// =============================================================================
// `school.lateFeeFlatMinor` is a figure in the SCHOOL's own currency. An INVOICE
// carries its own — this platform bills USD through Stripe alongside a school's
// local rail, and CLAUDE.md says so explicitly.
//
// The sweep applied the flat fee to every overdue invoice whatever it was raised
// in. Measured live on one school with a policy of 250,000 minor (NGN 2,500):
//
//   invoice e7c39f10  NGN   late fee 250000  ->  NGN 2,500.00   as intended
//   invoice 99ce66b2  USD   late fee 250000  ->  USD 2,500.00   ~1,600x
//
// Fifth instance of "A NAIRA CONSTANT IS NOT A RULE FOR EVERY SCHOOL", and the
// same answer as the other four: there is no FX rate in this platform, so an
// invoice in a currency the policy does not describe is SKIPPED — never
// converted, never guessed at. An unset charge goes to zero, because a charge
// that guesses bills a family.
// =============================================================================

import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(join(__dirname, "../../src/fees/fee-ops.service.ts"), "utf8");

/** The `where` the sweep sends for overdue invoices. */
function sweepWhere(): string {
  const at = SRC.indexOf("tx.invoice.findMany({");
  expect(at).toBeGreaterThan(-1);
  return SRC.slice(at, at + 1600);
}

describe("a late fee is money of one kind", () => {
  it("charges only invoices raised in the school's own currency", () => {
    // The filter is in the QUERY, not a skip in Node afterwards — same ordering
    // rule the marker check already follows, so `take` bounds the WORK.
    expect(sweepWhere()).toMatch(/currency:\s*schoolCurrency/);
  });

  it("resolves that currency the way every other read does", () => {
    // `resolveRegion`, not the raw column: a null currency means the platform's
    // home currency, which is what an unset school has always billed in — the
    // same reasoning the timezone two lines above already uses.
    expect(SRC).toMatch(/const schoolCurrency = resolveRegion\(school\)\.currency/);
  });

  it("asks the database for the currency it is about to compare", () => {
    // A select that omits it would make `schoolCurrency` undefined and match
    // NOTHING — a silent zero-fee sweep, which is the opposite failure.
    // Bounded to the select BLOCK, not a character count — the comments above
    // it are long, and a fixed window is the trap this repo keeps recording.
    const at = SRC.indexOf("isPlatform: false");
    const selectAt = SRC.indexOf("select: {", at);
    const select = SRC.slice(selectAt, SRC.indexOf("},", selectAt));
    expect(select).toMatch(/currency:\s*true/);
  });

  it("keeps the flat fee itself unconverted", () => {
    // No FX anywhere near this. The fee is the school's own figure, applied to
    // the school's own currency, or not applied at all.
    expect(SRC).not.toMatch(/exchangeRate|fxRate|convertCurrency/i);
  });
});

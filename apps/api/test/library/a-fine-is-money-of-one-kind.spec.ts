// =============================================================================
// A NGN 350 library fine billed as USD 350.00
// =============================================================================
// `fineMinor` is days x `effectiveLibraryFinePerDayMinor` — a figure in the
// SCHOOL's currency. `billFine` attached it to the most recent live invoice
// WHATEVER it was raised in, and invoices carry their own currency per row
// because the platform bills USD through Stripe alongside a school's local rail.
//
// Measured live: a book seven days late at NGN 50/day billed 35,000 onto a
// pupil's live USD invoice — $350.00 on a family's bill, ~550x the NGN 350
// intended.
//
// The comment ten lines above the lookup worried about exactly this
// ("settlement refuses a charge whose currency differs from the invoice") and
// the `create` branch sets `school.currency` correctly. Only the branch that
// PREFERS an existing invoice never asked.
// =============================================================================

import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(join(__dirname, "../../src/library/library.service.ts"), "utf8");

/** The lookup that chooses which invoice a fine lands on. */
function invoiceLookup(): string {
  const at = SRC.indexOf("let invoice = await tx.invoice.findFirst({");
  expect(at).toBeGreaterThan(-1);
  return SRC.slice(at, SRC.indexOf("});", at));
}

describe("a fine is money of one kind", () => {
  it("only reuses an invoice in the school\'s own currency", () => {
    expect(invoiceLookup()).toMatch(/currency:\s*schoolCurrency/);
  });

  it("still keeps the live-debt rule it already had", () => {
    // A DRAFT is not a bill and a PAID invoice must not be reopened — both
    // reasoned out at length above the lookup. The currency filter is an
    // addition, not a replacement.
    expect(invoiceLookup()).toMatch(/ISSUED/);
    expect(invoiceLookup()).toMatch(/PARTIALLY_PAID/);
    expect(invoiceLookup()).not.toMatch(/DRAFT/);
  });

  it("raises a new invoice in that same currency when none matches", () => {
    // The fine is a NEW charge and must land somewhere — unlike the late-fee
    // sweep, where nothing matching means there is nothing to do.
    const at = SRC.indexOf("reference: `FINE-");
    expect(SRC.slice(at - 400, at + 400)).toMatch(/currency:\s*schoolCurrency/);
  });

  it("resolves the school currency once, not twice with different fallbacks", () => {
    // Two spellings of one default is how a pair drifts.
    expect(SRC).toMatch(/const schoolCurrency = school\?\.currency \?\? "NGN"/);
    expect((SRC.match(/school\?\.currency \?\? "NGN"/g) ?? []).length).toBe(1);
  });
});

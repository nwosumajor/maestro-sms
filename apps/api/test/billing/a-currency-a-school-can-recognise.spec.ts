import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CURRENCIES, currencyLabel, planCurrencies, DEFAULT_PLAN } from "@sms/types";

/**
 * The checkout's currency picker is where a school chooses what it pays in, so
 * every option has to NAME the money it stands for.
 *
 * It did not. The label was `c === "NGN" ? "₦ Naira" : "$ US Dollar"` — a
 * two-way ternary written when the platform sold in exactly two currencies —
 * so the day GHS opened, a Ghanaian school's own cedi option rendered as
 * "$ US Dollar". The one option they were meant to pick was labelled as
 * somebody else's money, on the screen that takes their card.
 *
 * The same two-currency assumption was in the card's own description ("can be
 * paid in naira or US dollars"), which is prose stating a fact that had
 * stopped being true — the class this repo keeps finding in its own notes.
 */

// COMMENTS STRIPPED FIRST. The comment explaining this very fix quotes the
// ternary it replaced, so a scan of the raw file fails on the explanation of
// its own fix — the trap `money-is-not-divided-by-a-hundred` already records.
const CHECKOUT = readFileSync(
  join(__dirname, "..", "..", "..", "..", "apps", "web", "components", "billing", "BillingCheckout.tsx"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("every currency on offer names itself", () => {
  it("names each of the currencies the platform actually sells in", () => {
    const sold = planCurrencies(DEFAULT_PLAN);
    expect(sold.length).toBeGreaterThan(1);
    for (const c of sold) {
      const label = currencyLabel(c);
      // The CODE always leads: on a platform billing in several currencies it
      // is the unambiguous half, the same conclusion `formatMoneyPdf` reached
      // about symbols.
      expect(label.startsWith(c)).toBe(true);
      // And it is not JUST the code where the runtime can do better, or the
      // picker is a list of three-letter acronyms.
      expect(label.length).toBeGreaterThan(c.length);
    }
  });

  it("never names one currency with another's name", () => {
    // The actual defect: GHS reading as US Dollar.
    expect(currencyLabel(CURRENCIES.GHS)).not.toMatch(/dollar/i);
    expect(currencyLabel(CURRENCIES.NGN)).not.toMatch(/dollar|cedi/i);
    expect(currencyLabel(CURRENCIES.USD)).not.toMatch(/naira|cedi/i);
  });

  it("falls back to the code rather than throwing on a currency it cannot name", () => {
    // A runtime with no display-name data must still render a usable picker.
    expect(currencyLabel("ZZZ")).toBe("ZZZ");
  });

  it("is what the picker uses, not a ternary over two currencies", () => {
    expect(CHECKOUT).toMatch(/\{currencyLabel\(c\)\}/);
    // No hard-coded pair may name an option again.
    expect(CHECKOUT).not.toMatch(/c === "NGN" \? .* : .*Dollar/);
  });

  it("does not state a currency list in prose that a third currency makes false", () => {
    expect(CHECKOUT).not.toMatch(/paid in naira or US dollars/i);
  });
});

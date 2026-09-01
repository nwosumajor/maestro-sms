import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";

/**
 * A school whose OWN currency the platform sells in, but cannot CHARGE today,
 * is the case that started this: MeastroTest is a Ghanaian school, its
 * dashboard reads GHS, and its billing console quoted naira with nothing
 * anywhere saying why.
 *
 * The default already falls back to a chargeable currency, so nobody meets a
 * dead button. Falling back SILENTLY is the defect: the school is shown a
 * price in money that is not theirs, and has no way to tell a deliberate
 * choice from a bug.
 *
 * So the page states three things: which currency is theirs, WHY it cannot be
 * used yet, and which ones CAN be — the alternatives, named, rather than left
 * for the reader to find by opening a dropdown.
 */

const src = (...p: string[]) =>
  stripComments(readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8"))
    
    ;

const CHECKOUT = src("apps", "web", "components", "billing", "BillingCheckout.tsx");
const PAGE = src("apps", "web", "app", "(app)", "billing", "page.tsx");
const SERVICE = src("apps", "api", "src", "billing", "billing.service.ts");
const DTO = src("packages", "types", "src", "dto", "billing.ts");

describe("the school's own currency, when it cannot be charged", () => {
  it("is carried on the wire rather than guessed at by the page", () => {
    // A page cannot compute this: it needs the school's region AND what the
    // platform sells in. Guessing either produced the naira quote.
    expect(DTO).toMatch(/preferredCurrency: Currency \| null/);
    expect(SERVICE).toMatch(/preferredCurrency:/);
    expect(PAGE).toMatch(/preferredCurrency=\{data\.preferredCurrency\}/);
  });

  it("is NULL when the platform cannot sell in it at all, not a false promise", () => {
    // "sellable but not chargeable today" and "we do not sell in your money"
    // are different sentences, and only the first has alternatives to offer.
    expect(SERVICE).toMatch(
      /planCurrencies\(DEFAULT_PLAN\)\.includes\(schoolCurrency as Currency\)\s*\n?\s*\?\s*\(schoolCurrency as Currency\)\s*\n?\s*:\s*null/,
    );
  });

  it("says so ONLY when their currency is real, unselected, and unchargeable", () => {
    // Each of the three conditions is load-bearing. Without the last it fires
    // for a school being charged in its own currency perfectly happily, and a
    // notice that appears when nothing is wrong is one nobody reads.
    expect(CHECKOUT).toMatch(/preferredCurrency &&/);
    expect(CHECKOUT).toMatch(/preferredCurrency !== effectiveCurrency &&/);
    expect(CHECKOUT).toMatch(/!\(chargeable as string\[\]\)\.includes\(preferredCurrency\)/);
  });

  it("gives the server's REASON rather than a general apology", () => {
    // The server already knows it is the gateway account, not the school.
    expect(CHECKOUT).toMatch(
      /currencyAvailability\.find\(\(a\) => a\.currency === preferredCurrency\)\?\.reason/,
    );
  });

  it("names the alternatives from what can be charged, never a fixed pair", () => {
    expect(CHECKOUT).toMatch(/\{chargeable\.join\(" or "\)\}/);
    expect(CHECKOUT).toMatch(/chargeable\.length > 0 \?/);
  });

  it("says what to do when there is no alternative at all", () => {
    // Listing nothing and stopping is how a school is left with a page that
    // quotes a price it cannot pay and no next step.
    expect(CHECKOUT).toMatch(/No currency can be charged right now/);
  });

  it("does not claim school FEES are affected, because they are not", () => {
    // `school.currency` bills families; the subscription currency bills the
    // platform. Conflating them would frighten a bursar for no reason.
    expect(CHECKOUT).toMatch(/school fees are unaffected/);
  });
});

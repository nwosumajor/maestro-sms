import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";
import {
  DEFAULT_PLAN,
  MODULE_ADDON_PRICING,
  PLANS,
  PLAN_PRICING_BY_CURRENCY,
  planCurrencies,
} from "@sms/types";

/**
 * The operator prices every tier and every sold-separately module here, and the
 * console READS what the platform ships and POSTS all of it back. So the write
 * side has to accept exactly what the read side produced.
 *
 * It did not. Both pricing schemas hand-listed `["NGN","USD"]` and hand-computed
 * a row cap for two currencies, so opening a third market broke the console —
 * and the TIER cap was the sharper half, because it broke saving in EVERY
 * currency rather than only the new one: 12 rows rendered against a cap of 7.
 * Measured live before the fix, as the platform owner:
 *
 *     PUT /operator/pricing  -> 400
 *     "Array must contain at most 7 element(s)"
 *     "Invalid enum value. Expected 'NGN' | 'USD', received 'GHS'"  (x4)
 *
 * The add-on side refused in TWO layers — the schema AND a service check that
 * named the two currencies as the rule — so fixing the schema alone would have
 * looked right and still refused.
 */

const src = (...p: string[]) =>
  stripComments(readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8"))
    
    ;

const CONTROLLER = src("apps", "api", "src", "operator", "operator.controller.ts");
const ADDON_SERVICE = src("apps", "api", "src", "billing", "addon-pricing.service.ts");
const MANAGER = src("apps", "web", "components", "operator", "PricingManager.tsx");

describe("what the platform sells in is asked, never restated", () => {
  it("planCurrencies is derived from the price lists it claims to describe", () => {
    // Its own comment says "only what the platform ships PRICES for" and then
    // repeated the answer as a literal — so a fourth price list would have been
    // shipped and sold to nobody, silently.
    expect(planCurrencies(DEFAULT_PLAN).sort()).toEqual(
      Object.keys(PLAN_PRICING_BY_CURRENCY).sort(),
    );
    expect(planCurrencies(DEFAULT_PLAN).length).toBeGreaterThan(2);
  });

  it("every currency it names really has a full tier price list", () => {
    // A currency offered with a hole in its ladder is a checkout that cannot
    // complete — the refusal `PlanPricingService.effective` already makes.
    for (const c of planCurrencies(DEFAULT_PLAN)) {
      for (const plan of Object.values(PLANS)) {
        expect(PLAN_PRICING_BY_CURRENCY[c]?.[plan]?.perSeatMonthlyMinor).toBeGreaterThan(0);
      }
    }
  });
});

describe("the save accepts exactly what the console renders", () => {
  it("both schemas take their currencies from the selling list", () => {
    expect(CONTROLLER).toMatch(
      /const SELLING_CURRENCIES = planCurrencies\(DEFAULT_PLAN\) as \[Currency, \.\.\.Currency\[\]\]/,
    );
    // Two schemas, one source. A second literal is how this pair drifted.
    expect(CONTROLLER.match(/z\.enum\(SELLING_CURRENCIES\)/g) ?? []).toHaveLength(2);
    expect(CONTROLLER).not.toMatch(/z\.enum\(\["NGN", "USD"\]\)/);
    expect(CONTROLLER).not.toMatch(/z\.enum\(\[CURRENCIES\.NGN, CURRENCIES\.USD\]\)/);
  });

  it("neither row cap can be smaller than a full save", () => {
    // A cap is a DoS bound, not a business rule: too large costs nothing, too
    // small breaks the console silently.
    expect(CONTROLLER).toMatch(
      /\.max\(Object\.keys\(PLANS\)\.length \* SELLING_CURRENCIES\.length\)/,
    );
    expect(CONTROLLER).toMatch(
      /\.max\(Object\.keys\(MODULE_ADDON_PRICING\)\.length \* SELLING_CURRENCIES\.length\)/,
    );
    // And the derived tier cap really does cover a full save today — the
    // number the console posts, which is every shipped (tier, currency) row.
    const currencies = planCurrencies(DEFAULT_PLAN);
    const shippedRows = currencies.reduce(
      (n, c) => n + Object.keys(PLAN_PRICING_BY_CURRENCY[c] ?? {}).length,
      0,
    );
    expect(shippedRows).toBe(12);
    expect(Object.keys(PLANS).length * currencies.length).toBeGreaterThanOrEqual(shippedRows);
  });

  it("the SERVICE layer asks the same question, not a second list", () => {
    // The add-on refusal lived twice. Fixing the schema alone would have looked
    // right and still refused at the service.
    expect(ADDON_SERVICE).toMatch(/planCurrencies\(DEFAULT_PLAN\)\.includes\(r\.currency as Currency\)/);
    expect(ADDON_SERVICE).not.toMatch(/Add-ons are priced in NGN or USD/);
  });
});

describe("the console says what it is pricing", () => {
  it("names each currency rather than assuming one of two", () => {
    expect(MANAGER).toMatch(/\{currencyLabel\(currency\)\}/);
    expect(MANAGER).not.toMatch(/currency === "NGN" \? "Naira/);
  });

  it("does not tie a card rail to a currency", () => {
    // `pickCardRail` falls back to Paystack for USD while Stripe is off, so
    // naming the gateway from the currency told the operator the wrong one —
    // the claim the checkout already stopped making.
    expect(MANAGER).not.toMatch(/\(Stripe\)|\(Paystack\)/);
    expect(MANAGER).not.toMatch(/dollar prices via Stripe/);
  });

  it("does not claim ENTERPRISE is sold in one currency", () => {
    // It ships prices in every selling currency, and no service rule refuses
    // the others — the claim was stale in the prose AND in the file header.
    expect(MANAGER).not.toMatch(/sold in dollars only|USD-ONLY/);
    for (const c of planCurrencies(DEFAULT_PLAN)) {
      expect(PLAN_PRICING_BY_CURRENCY[c]?.[PLANS.ENTERPRISE]).toBeDefined();
    }
  });
});

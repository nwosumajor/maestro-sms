// =============================================================================
// A naira figure, quoted in dollars
// =============================================================================
// Tier prices have been per-currency since dual-currency billing shipped:
// PLAN_PRICING_BY_CURRENCY in code, `plan_price` keyed (plan, currency) in the
// database, and `PlanPricingService.effective()` REFUSES a currency it has no
// prices for — its comment saying why: "quoting a tier at zero, OR SILENTLY AT
// THE NAIRA PRICE, is worse than saying the market is not open yet."
//
// The add-on table beside it was one bare number for every market, and
// `AddonPricingService.resolve()` wrote USD out explicitly and gave it the kobo
// figures. `module_addon_price` has no rows, so that is what every school got:
// a USD school was quoted HOSTEL at 12,500 cents — $125 per seat per month
// against a $0.65 ULTIMATE tier, roughly 192x the tier containing it.
//
// This drives the REAL service, because the pure table being right proves
// nothing about the resolver that seeds it — that seam is where this lived.
// =============================================================================

import {
  CURRENCIES,
  MODULE_ADDON_PRICING,
  MODULE_ADDON_PRICING_BY_CURRENCY,
  MODULE_ADDON_PRICING_USD,
  MODULES,
  PLAN_PRICING_BY_CURRENCY,
  PLANS,
} from "@sms/types";
import { AddonPricingService } from "../../src/billing/addon-pricing.service";

function serviceWithNoOperatorRows(): AddonPricingService {
  const db = {
    runAsTenantReadOnly: async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn({ moduleAddonPrice: { findMany: async () => [] } }),
  };
  return new AddonPricingService(
    db as never,
    { record: async () => undefined } as never,
    {} as never,
  );
}

describe("an add-on price is not a naira price", () => {
  it("quotes a USD school in dollars, not in kobo wearing a dollar sign", async () => {
    const prices = await serviceWithNoOperatorRows().effective(CURRENCIES.USD);
    // The figure that shipped: 12,500 — $125.00 per seat per month.
    expect(prices[MODULES.HOSTEL]).not.toBe(MODULE_ADDON_PRICING[MODULES.HOSTEL]);
    expect(prices[MODULES.HOSTEL]).toBe(MODULE_ADDON_PRICING_USD[MODULES.HOSTEL]);
  });

  it("never quotes one module above the whole tier that contains it", async () => {
    // The property a school would notice, in the currency they are billed in.
    const svc = serviceWithNoOperatorRows();
    for (const currency of Object.keys(MODULE_ADDON_PRICING_BY_CURRENCY)) {
      const prices = await svc.effective(currency as "USD");
      const ultimate = PLAN_PRICING_BY_CURRENCY[currency as "USD"][PLANS.ULTIMATE].perSeatMonthlyMinor;
      expect(prices[MODULES.HOSTEL]!).toBeLessThan(ultimate);
    }
  });

  it("leaves a naira school exactly as it was", async () => {
    const prices = await serviceWithNoOperatorRows().effective(CURRENCIES.NGN);
    expect(prices).toEqual({ ...MODULE_ADDON_PRICING });
  });

  it("refuses a currency it has no prices for rather than inventing one", async () => {
    // The rule PlanPricingService already follows. A market with no price list
    // is a market not open yet — saying so names the fix; quoting another
    // currency's figures does not.
    // GHS is now a SHIPPED currency, so it is no longer the example of one
    // without prices — KES is. The rule is unchanged and this test moved with
    // the data rather than being deleted: a market with no price list is a
    // market not open yet.
    await expect(serviceWithNoOperatorRows().effective("KES" as "USD")).rejects.toThrow(
      /No add-on pricing for KES/,
    );
  });
});

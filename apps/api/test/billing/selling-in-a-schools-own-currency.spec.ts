/**
 * SELLING A SCHOOL ITS SUBSCRIPTION IN ITS OWN CURRENCY.
 *
 * A Ghanaian school read GHS on its dashboard and a naira figure on its billing
 * page. Both were true — fee currency and subscription currency are different
 * questions — but the school had never been OFFERED cedis: `planCurrencies()`
 * shipped prices for NGN and USD only, so naira or dollars were the only
 * options, and it paid FX on every renewal. Paystack settles GHS; the rail was
 * never the obstacle, the price list was.
 *
 * FIVE PLACES HAD TO AGREE, and four of them were hand-kept lists that had
 * fallen behind the moment a currency was added:
 *
 *   PLAN_PRICING_BY_CURRENCY     the tier list          (added GHS)
 *   MODULE_ADDON_PRICING_*       the add-on list        (added GHS — without it
 *                                a GHS school can subscribe and buy no add-on)
 *   planCurrencies()             what may be sold       (added GHS)
 *   PlanPricingService.resolve() hard-coded {NGN, USD}  (now reads every list)
 *   billing checkout schema      z.enum(["NGN","USD"])  (now derived)
 *
 * The fourth is the one that mattered most: it seeded any new currency from the
 * NAIRA table, so GHS quoted GHS 525 a seat instead of GHS 3.50 — about 150x.
 * Measured live before the fix.
 */
import {
  DEFAULT_PLAN,
  MODULE_ADDON_PRICING_BY_CURRENCY,
  PLANS,
  PLAN_PRICING_BY_CURRENCY,
  planCurrencies,
  type ModuleKey,
} from "@sms/types";
import { sellableAlone } from "../../src/billing/addon-pricing.service";

describe("GHS is a market the platform can actually sell in", () => {
  it("ships a tier price list", () => {
    expect(PLAN_PRICING_BY_CURRENCY.GHS).toBeDefined();
    for (const plan of Object.values(PLANS)) {
      expect({ plan, priced: (PLAN_PRICING_BY_CURRENCY.GHS?.[plan]?.perSeatMonthlyMinor ?? 0) > 0 })
        .toEqual({ plan, priced: true });
    }
  });

  it("ships an add-on price for every module sold alone", () => {
    // A currency with tier prices and no add-on prices is worse than one with
    // neither: `AddonPricingService.effective()` refuses, so the school could
    // subscribe and buy nothing.
    for (const module of sellableAlone() as ModuleKey[]) {
      expect({ module, priced: (MODULE_ADDON_PRICING_BY_CURRENCY.GHS?.[module] ?? 0) > 0 })
        .toEqual({ module, priced: true });
    }
  });

  it("is offered for sale", () => {
    expect(planCurrencies(DEFAULT_PLAN)).toContain("GHS");
  });

  it("keeps the tier ladder the other currencies keep", () => {
    // The ratios mirror NGN deliberately: the gap between tiers is a product
    // decision that should not change per market. Only the base moves.
    const ghs = PLAN_PRICING_BY_CURRENCY.GHS!;
    const seats = (p: keyof typeof ghs) => ghs[p].perSeatMonthlyMinor;
    expect(seats(PLANS.STANDARD)).toBeLessThan(seats(PLANS.PREMIUM));
    expect(seats(PLANS.PREMIUM)).toBeLessThan(seats(PLANS.ULTIMATE));
    expect(seats(PLANS.ULTIMATE)).toBeLessThan(seats(PLANS.ENTERPRISE));
  });
});

describe("no list is kept by hand any more", () => {
  const RESOLVER = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "..", "src", "billing", "plan-pricing.service.ts"),
    "utf8",
  );
  const CONTROLLER = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "..", "src", "billing", "billing.controller.ts"),
    "utf8",
  );

  it("the resolver seeds from EVERY shipped list", () => {
    // It named NGN and USD literally, so a new list was invisible to it.
    expect(RESOLVER).toMatch(/Object\.entries\(PLAN_PRICING_BY_CURRENCY\)/);
    expect(RESOLVER).not.toMatch(/NGN: \{ \.\.\.PLAN_PRICING_BY_CURRENCY\.NGN \}/);
  });

  it("a currency opened by operator rows does NOT inherit naira prices", () => {
    // The table used to be created as a copy of NGN, so pricing one tier in a
    // new currency silently sold the other three at naira figures — the
    // "silently at the naira price" this service's own refusal exists to stop,
    // reached through the other door.
    expect(RESOLVER).toContain("openedByOperator");
    expect(RESOLVER).not.toMatch(/\?\?= \{ \.\.\.PLAN_PRICING_BY_CURRENCY\.NGN \}/);
  });

  it("the checkout accepts exactly what the platform sells", () => {
    // Quoted, priced, and then refused at the last step is the same defect this
    // repo keeps finding in the other direction.
    expect(CONTROLLER).toMatch(/z\s*\n?\s*\.enum\(planCurrencies\(DEFAULT_PLAN\)/);
  });
});

describe("a school is quoted in its own currency first", () => {
  const SERVICE = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "..", "src", "billing", "billing.service.ts"),
    "utf8",
  );

  it("defaults an unpaid subscription to the school's currency when sellable", () => {
    expect(SERVICE).toMatch(/planCurrencies\(DEFAULT_PLAN\)\.includes\(schoolCurrency as Currency\)/);
  });

  it("but never re-denominates one that has already been paid", () => {
    // What a school was charged in is a fact; changing it from a region setting
    // would move what renewal costs without anybody deciding to.
    expect(SERVICE).toMatch(/subRow && isCurrency\(subRow\.currency \?\? ""\) \? \(subRow\.currency as Currency\) : preferred/);
  });

  it("leads the quote grid with it, so the choice is visible", () => {
    expect(SERVICE).toMatch(/quotes\.sort\(\(a, b\) => Number\(b\.currency === preferred\)/);
  });
});

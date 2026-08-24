// =============================================================================
// Selling one module, without letting schools assemble their own tier
// =============================================================================
// `ModuleOverrides.enabled` could already force any module on for any school and
// nothing charged for it: a per-school override was a free comp, not a product.
// So a school that wanted only the exam hall faced the whole jump to the next
// tier for modules it would never open, and the operator's only alternative was
// to give it away.
//
// Add-ons are priced PER SEAT, like the tiers, so the same lever scales with the
// same thing and a school's bill is explainable in one sentence.
//
// THE RULE THAT KEEPS THE FUNNEL HONEST, and the reason this file exists: an
// add-on always costs MORE per module than the tier that contains it. If three
// add-ons were cheaper than the upgrade, every school would assemble its own
// tier and the ladder would stop meaning anything. Priced this way, ONE add-on
// is the cheapest route to one module, TWO is close, and by THREE the upgrade is
// plainly better — which is the outcome worth encouraging, because a school on a
// higher tier churns less than one holding four unrelated add-ons.
//
// That is proven here for EVERY module rather than trusted to stay right by
// hand, because it is the kind of arithmetic that rots one edit at a time.
// =============================================================================

import {
  MODULES,
  MODULE_ADDON_PRICING,
  PLANS,
  PLAN_MODULES,
  PLAN_PRICING,
  addonPerSeatMonthlyMinor,
  billableAddons,
  NOT_SOLD_SEPARATELY,
  computeSubscriptionPriceMinor,
  type ModuleKey,
  type Plan,
} from "@sms/types";

const LADDER: Plan[] = [PLANS.STANDARD, PLANS.PREMIUM, PLANS.ULTIMATE, PLANS.ENTERPRISE];

/** The tier that first includes `m`, and what that tier's step costs per seat. */
function tierStepFor(m: ModuleKey): { plan: Plan; stepMinor: number; adds: number } | null {
  for (let i = 1; i < LADDER.length; i++) {
    const below = new Set(PLAN_MODULES[LADDER[i - 1]]);
    if (!PLAN_MODULES[LADDER[i]].includes(m) || below.has(m)) continue;
    return {
      plan: LADDER[i],
      stepMinor: PLAN_PRICING[LADDER[i]].perSeatMonthlyMinor - PLAN_PRICING[LADDER[i - 1]].perSeatMonthlyMinor,
      adds: PLAN_MODULES[LADDER[i]].filter((x) => !below.has(x)).length,
    };
  }
  return null;
}

describe("what an add-on costs against the tier that contains it", () => {
  const priced = Object.keys(MODULE_ADDON_PRICING) as ModuleKey[];

  it("prices every module that is not already in the entry tier", () => {
    // A module with no add-on price cannot be sold on its own, which is the
    // situation this whole mechanism exists to end.
    const core = new Set(PLAN_MODULES[PLANS.STANDARD]);
    const deliberate = new Set(NOT_SOLD_SEPARATELY);
    const unsellableAlone = PLAN_MODULES[PLANS.ENTERPRISE].filter(
      (m) => !core.has(m) && !deliberate.has(m) && MODULE_ADDON_PRICING[m] === undefined,
    );
    expect(unsellableAlone).toEqual([]);
  });

  it("prices NO entry-tier module — those are not add-ons, they are included", () => {
    const core = PLAN_MODULES[PLANS.STANDARD];
    expect(core.filter((m) => MODULE_ADDON_PRICING[m] !== undefined)).toEqual([]);
  });

  it("always costs MORE alone than it does inside its tier", () => {
    // The core inequality. Violated, a school buys the module for less than the
    // upgrade charges for it, and the tier is worth nothing.
    const cheap: string[] = [];
    for (const m of priced) {
      const t = tierStepFor(m);
      if (!t) continue;
      const perModuleInTier = t.stepMinor / t.adds;
      if ((MODULE_ADDON_PRICING[m] ?? 0) <= perModuleInTier) {
        cheap.push(`${m}: add-on ${MODULE_ADDON_PRICING[m]} <= ${perModuleInTier} inside ${t.plan}`);
      }
    }
    expect(cheap).toEqual([]);
  });

  it("makes the UPGRADE the better buy by the third add-on", () => {
    // Not a hard requirement of the arithmetic — a proof that the prices chosen
    // actually produce the funnel described, for the tier most likely to be
    // assembled piecemeal.
    // Checked for EVERY step of the ladder, not just one — and where a step adds
    // fewer than three sellable modules, buying all of them must still beat it.
    for (let i = 1; i < LADDER.length; i++) {
      const below = new Set(PLAN_MODULES[LADDER[i - 1]]);
      const sellable = PLAN_MODULES[LADDER[i]]
        .filter((m) => !below.has(m))
        .map((m) => MODULE_ADDON_PRICING[m])
        .filter((v): v is number => v !== undefined)
        .sort((a, b) => a - b);
      const step = PLAN_PRICING[LADDER[i]].perSeatMonthlyMinor - PLAN_PRICING[LADDER[i - 1]].perSeatMonthlyMinor;
      const takeN = Math.min(3, sellable.length);
      const cheapest = sellable.slice(0, takeN).reduce((a, b) => a + b, 0);
      expect([LADDER[i], cheapest > step]).toEqual([LADDER[i], true]);
    }
  });
});

describe("what a school is actually billed", () => {
  const seats = 100;
  const YEARLESS = "MONTH" as const;

  it("charges nothing extra when there are no add-ons", () => {
    const plain = computeSubscriptionPriceMinor(PLANS.STANDARD, seats, YEARLESS, PLAN_PRICING);
    const withEmpty = computeSubscriptionPriceMinor(PLANS.STANDARD, seats, YEARLESS, PLAN_PRICING, {
      enabled: [],
      disabled: [],
    });
    expect(withEmpty).toBe(plain);
  });

  it("charges the add-on per seat, on top of the tier", () => {
    const plain = computeSubscriptionPriceMinor(PLANS.STANDARD, seats, YEARLESS, PLAN_PRICING);
    const withHr = computeSubscriptionPriceMinor(PLANS.STANDARD, seats, YEARLESS, PLAN_PRICING, {
      enabled: [MODULES.HR],
    });
    expect(withHr - plain).toBe((MODULE_ADDON_PRICING[MODULES.HR] ?? 0) * seats);
  });

  it("does NOT bill a module the tier already includes", () => {
    // The likeliest way this goes wrong: an operator comps a module, the school
    // later upgrades, and the override is left behind. Billing it twice would
    // be a charge nobody could explain.
    const enterprise = computeSubscriptionPriceMinor(PLANS.ENTERPRISE, seats, YEARLESS, PLAN_PRICING);
    const withStaleOverride = computeSubscriptionPriceMinor(PLANS.ENTERPRISE, seats, YEARLESS, PLAN_PRICING, {
      enabled: [MODULES.HR, MODULES.GROUP],
    });
    expect(withStaleOverride).toBe(enterprise);
    expect(billableAddons(PLANS.ENTERPRISE, { enabled: [MODULES.HR] })).toEqual([]);
  });

  it("means an upgrade ABSORBS an add-on rather than stacking on it", () => {
    // The number that makes the upgrade argument by itself: the same school,
    // quoted for two tiers, pays less extra on the tier that includes what it
    // already bought.
    const overrides = { enabled: [MODULES.HR] };
    const standardWithAddon = addonPerSeatMonthlyMinor(PLANS.STANDARD, overrides);
    const enterpriseWithAddon = addonPerSeatMonthlyMinor(PLANS.ENTERPRISE, overrides);
    expect(standardWithAddon).toBeGreaterThan(0);
    expect(enterpriseWithAddon).toBe(0);
  });

  it("ignores an override naming something that is not a module we sell alone", () => {
    const core = PLAN_MODULES[PLANS.STANDARD][0];
    expect(billableAddons(PLANS.STANDARD, { enabled: [core] })).toEqual([]);
  });
});

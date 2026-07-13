// =============================================================================
// Platform billing — pure pricing + effective-plan unit tests (no DB)
// =============================================================================
// Pins the two pure functions the whole revenue layer rests on:
//   - computeSubscriptionPriceMinor: per-seat × cycle months, seat clamp
//   - effectivePlan: status-driven downgrade that NEVER mutates the purchased
//     plan (the STANDARD floor while past-due beyond grace / canceled past period end)
// =============================================================================

import {
  BILLING_CYCLES,
  CYCLE_MONTHS,
  PLANS,
  PLAN_PRICING,
  SUBSCRIPTION_GRACE_DAYS,
  SUBSCRIPTION_STATUS,
  applyCycleDiscountMinor,
  computeSubscriptionGrossMinor,
  computeSubscriptionPriceMinor,
  effectivePlan,
} from "@sms/types";

describe("computeSubscriptionPriceMinor", () => {
  it("is per-seat × monthly rate × cycle months, minus the commitment discount", () => {
    const seats = 400;
    const monthly = PLAN_PRICING.STANDARD.perSeatMonthlyMinor;
    // MONTH: 1 month, no discount.
    expect(computeSubscriptionPriceMinor(PLANS.STANDARD, seats, BILLING_CYCLES.MONTH)).toBe(monthly * seats * 1);
    // TERM: 3 months at 5% off.
    expect(CYCLE_MONTHS.TERM).toBe(3);
    expect(computeSubscriptionPriceMinor(PLANS.STANDARD, seats, BILLING_CYCLES.TERM)).toBe(
      Math.round(monthly * seats * 3 * 0.95),
    );
    // YEAR: 9 billed months (3 terms) at 15% off.
    expect(CYCLE_MONTHS.YEAR).toBe(9);
    expect(computeSubscriptionPriceMinor(PLANS.STANDARD, seats, BILLING_CYCLES.YEAR)).toBe(
      Math.round(monthly * seats * 9 * 0.85),
    );
  });

  it("discount rounding is deterministic and integer (kobo/cents never fractional)", () => {
    // 3 seats × ₦333.33 × 3 months × 0.95 exercises the rounding path.
    const odd = { ...PLAN_PRICING, STANDARD: { perSeatMonthlyMinor: 33_333 } };
    const gross = computeSubscriptionGrossMinor(PLANS.STANDARD, 3, BILLING_CYCLES.TERM, odd);
    const net = computeSubscriptionPriceMinor(PLANS.STANDARD, 3, BILLING_CYCLES.TERM, odd);
    expect(Number.isInteger(net)).toBe(true);
    expect(net).toBe(Math.round(gross * 0.95));
    expect(net).toBe(applyCycleDiscountMinor(gross, BILLING_CYCLES.TERM));
  });

  it("a year (9 months at 15% off) beats three terms (9 months at 5% off)", () => {
    const seats = 250;
    const threeTerm = 3 * computeSubscriptionPriceMinor(PLANS.PREMIUM, seats, BILLING_CYCLES.TERM);
    const year = computeSubscriptionPriceMinor(PLANS.PREMIUM, seats, BILLING_CYCLES.YEAR);
    expect(year).toBeLessThan(threeTerm);
  });

  it("clamps seats to at least 1 (never charges for 0 students)", () => {
    const monthly = PLAN_PRICING.ENTERPRISE.perSeatMonthlyMinor;
    expect(computeSubscriptionPriceMinor(PLANS.ENTERPRISE, 0, BILLING_CYCLES.MONTH)).toBe(monthly * 1);
    expect(computeSubscriptionPriceMinor(PLANS.ENTERPRISE, -5, BILLING_CYCLES.MONTH)).toBe(monthly * 1);
  });

  it("higher tiers cost more per seat (STANDARD < PREMIUM < ULTIMATE < ENTERPRISE)", () => {
    const std = PLAN_PRICING.STANDARD.perSeatMonthlyMinor;
    const prem = PLAN_PRICING.PREMIUM.perSeatMonthlyMinor;
    const ult = PLAN_PRICING.ULTIMATE.perSeatMonthlyMinor;
    const ent = PLAN_PRICING.ENTERPRISE.perSeatMonthlyMinor;
    expect(std).toBeLessThan(prem);
    expect(prem).toBeLessThan(ult);
    expect(ult).toBeLessThan(ent);
  });
});

describe("effectivePlan", () => {
  const now = new Date("2026-06-27T00:00:00Z");
  const future = new Date("2026-09-01T00:00:00Z");
  const justPast = new Date("2026-06-25T00:00:00Z"); // 2 days ago (within grace)
  const longPast = new Date("2026-06-01T00:00:00Z"); // 26 days ago (beyond grace)

  it("ACTIVE keeps the purchased plan regardless of period", () => {
    expect(effectivePlan(PLANS.ENTERPRISE, SUBSCRIPTION_STATUS.ACTIVE, null, SUBSCRIPTION_GRACE_DAYS, now)).toBe(
      PLANS.ENTERPRISE,
    );
    expect(effectivePlan(PLANS.STANDARD, SUBSCRIPTION_STATUS.ACTIVE, future, SUBSCRIPTION_GRACE_DAYS, now)).toBe(
      PLANS.STANDARD,
    );
  });

  it("PAST_DUE keeps the plan inside the grace window", () => {
    expect(effectivePlan(PLANS.ENTERPRISE, SUBSCRIPTION_STATUS.PAST_DUE, justPast, SUBSCRIPTION_GRACE_DAYS, now)).toBe(
      PLANS.ENTERPRISE,
    );
  });

  it("PAST_DUE drops to the STANDARD floor once the grace window elapses", () => {
    expect(effectivePlan(PLANS.ENTERPRISE, SUBSCRIPTION_STATUS.PAST_DUE, longPast, SUBSCRIPTION_GRACE_DAYS, now)).toBe(
      PLANS.STANDARD,
    );
  });

  it("CANCELED keeps the plan only until period end (no grace)", () => {
    expect(effectivePlan(PLANS.ULTIMATE, SUBSCRIPTION_STATUS.CANCELED, future, SUBSCRIPTION_GRACE_DAYS, now)).toBe(
      PLANS.ULTIMATE,
    );
    expect(effectivePlan(PLANS.ULTIMATE, SUBSCRIPTION_STATUS.CANCELED, justPast, SUBSCRIPTION_GRACE_DAYS, now)).toBe(
      PLANS.STANDARD,
    );
  });

  it("never enforces above the purchased plan", () => {
    // A past-due STANDARD school stays STANDARD (the floor), not bumped up.
    expect(effectivePlan(PLANS.STANDARD, SUBSCRIPTION_STATUS.PAST_DUE, longPast, SUBSCRIPTION_GRACE_DAYS, now)).toBe(
      PLANS.STANDARD,
    );
  });
});

// --- Dual-currency rules (NGN Paystack / USD Stripe; ENTERPRISE = USD only) ---
import {
  CURRENCIES,
  PLAN_PRICING_USD,
  defaultCurrencyFor,
  isCurrency,
  planCurrencies,
} from "@sms/types";

describe("currency rules", () => {
  it("ENTERPRISE is USD-only; other tiers sell in NGN and USD", () => {
    expect(planCurrencies(PLANS.ENTERPRISE)).toEqual([CURRENCIES.USD]);
    for (const plan of [PLANS.STANDARD, PLANS.PREMIUM, PLANS.ULTIMATE]) {
      expect(planCurrencies(plan)).toEqual([CURRENCIES.NGN, CURRENCIES.USD]);
    }
  });

  it("defaults: ₦ locally, $ for ENTERPRISE", () => {
    expect(defaultCurrencyFor(PLANS.ENTERPRISE)).toBe(CURRENCIES.USD);
    expect(defaultCurrencyFor(PLANS.STANDARD)).toBe(CURRENCIES.NGN);
  });

  it("isCurrency accepts only NGN/USD", () => {
    expect(isCurrency("NGN")).toBe(true);
    expect(isCurrency("USD")).toBe(true);
    expect(isCurrency("EUR")).toBe(false);
    expect(isCurrency(undefined)).toBe(false);
  });

  it("USD pricing computes in cents with the USD table", () => {
    const seats = 500;
    expect(
      computeSubscriptionPriceMinor(PLANS.ENTERPRISE, seats, BILLING_CYCLES.MONTH, PLAN_PRICING_USD),
    ).toBe(PLAN_PRICING_USD.ENTERPRISE.perSeatMonthlyMinor * seats);
  });
});

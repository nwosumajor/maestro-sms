// =============================================================================
// Platform billing — pure pricing + effective-plan unit tests (no DB)
// =============================================================================
// Pins the two pure functions the whole revenue layer rests on:
//   - computeSubscriptionPriceMinor: per-seat × cycle months, seat clamp
//   - effectivePlan: status-driven downgrade that NEVER mutates the purchased
//     plan (BASIC only while past-due beyond grace / canceled past period end)
// =============================================================================

import {
  BILLING_CYCLES,
  CYCLE_MONTHS,
  PLANS,
  PLAN_PRICING,
  SUBSCRIPTION_GRACE_DAYS,
  SUBSCRIPTION_STATUS,
  computeSubscriptionPriceMinor,
  effectivePlan,
} from "@sms/types";

describe("computeSubscriptionPriceMinor", () => {
  it("is per-seat × monthly rate × cycle months", () => {
    const seats = 400;
    const monthly = PLAN_PRICING.STANDARD.perSeatMonthlyMinor;
    expect(computeSubscriptionPriceMinor(PLANS.STANDARD, seats, BILLING_CYCLES.MONTH)).toBe(monthly * seats * 1);
    expect(computeSubscriptionPriceMinor(PLANS.STANDARD, seats, BILLING_CYCLES.TERM)).toBe(
      monthly * seats * CYCLE_MONTHS.TERM,
    );
    expect(computeSubscriptionPriceMinor(PLANS.STANDARD, seats, BILLING_CYCLES.YEAR)).toBe(monthly * seats * 12);
  });

  it("clamps seats to at least 1 (never charges for 0 students)", () => {
    const monthly = PLAN_PRICING.ENTERPRISE.perSeatMonthlyMinor;
    expect(computeSubscriptionPriceMinor(PLANS.ENTERPRISE, 0, BILLING_CYCLES.MONTH)).toBe(monthly * 1);
    expect(computeSubscriptionPriceMinor(PLANS.ENTERPRISE, -5, BILLING_CYCLES.MONTH)).toBe(monthly * 1);
  });

  it("BASIC is the free floor (₦0 at any size)", () => {
    expect(computeSubscriptionPriceMinor(PLANS.BASIC, 1000, BILLING_CYCLES.YEAR)).toBe(0);
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

  it("PAST_DUE drops to BASIC once the grace window elapses", () => {
    expect(effectivePlan(PLANS.ENTERPRISE, SUBSCRIPTION_STATUS.PAST_DUE, longPast, SUBSCRIPTION_GRACE_DAYS, now)).toBe(
      PLANS.BASIC,
    );
  });

  it("CANCELED keeps the plan only until period end (no grace)", () => {
    expect(effectivePlan(PLANS.STANDARD, SUBSCRIPTION_STATUS.CANCELED, future, SUBSCRIPTION_GRACE_DAYS, now)).toBe(
      PLANS.STANDARD,
    );
    expect(effectivePlan(PLANS.STANDARD, SUBSCRIPTION_STATUS.CANCELED, justPast, SUBSCRIPTION_GRACE_DAYS, now)).toBe(
      PLANS.BASIC,
    );
  });

  it("never enforces above the purchased plan", () => {
    // A past-due BASIC school stays BASIC, not bumped up.
    expect(effectivePlan(PLANS.BASIC, SUBSCRIPTION_STATUS.PAST_DUE, longPast, SUBSCRIPTION_GRACE_DAYS, now)).toBe(
      PLANS.BASIC,
    );
  });
});

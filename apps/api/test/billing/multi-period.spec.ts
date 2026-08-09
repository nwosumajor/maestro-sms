// =============================================================================
// Multi-period purchases, and the race that made repeated buying unsafe
// =============================================================================
// MEASURED, not theorised. Four concurrent RENEWAL webhooks against one school:
// all four returned 201, all four rows were marked PAID, and the subscription
// advanced 18 months instead of 36. The school paid four times and got two,
// with nothing anywhere reporting the discrepancy — the settlement path did a
// read-modify-write of currentPeriodEnd with no lock, so the last writer won.
//
// Two fixes, tested here at their two levels: the period arithmetic is now one
// pure rule shared by the quote and the settlement, and buying N periods is ONE
// charge that cannot race itself.
// =============================================================================

import {
  BILLING_CYCLES,
  CYCLE_MONTHS,
  MAX_BILLING_PERIODS,
  billedMonths,
  normalisePeriods,
  periodEndAfter,
} from "@sms/types";

describe("period arithmetic", () => {
  it("an academic YEAR is 9 billed months, not 12", () => {
    // The label is the ambiguity this whole feature had to work around: a
    // school reading "1 year" assumes twelve months. Holidays are not charged.
    expect(CYCLE_MONTHS[BILLING_CYCLES.YEAR]).toBe(9);
    expect(billedMonths(BILLING_CYCLES.YEAR, 1)).toBe(9);
  });

  it("multiplies cleanly — five years is 45 billed months in ONE charge", () => {
    expect(billedMonths(BILLING_CYCLES.YEAR, 5)).toBe(45);
    expect(billedMonths(BILLING_CYCLES.TERM, 4)).toBe(12);
    expect(billedMonths(BILLING_CYCLES.MONTH, 18)).toBe(18);
  });

  it("clamps a period count instead of trusting it", () => {
    // An unbounded multiplier is a way to turn a mistyped 5 into a 55-year
    // commitment; a zero or a fraction is a charge for nothing.
    expect(normalisePeriods(0)).toBe(1);
    expect(normalisePeriods(-3)).toBe(1);
    expect(normalisePeriods(2.7)).toBe(2);
    expect(normalisePeriods(999)).toBe(MAX_BILLING_PERIODS);
    expect(normalisePeriods(undefined)).toBe(1);
    expect(normalisePeriods("abc")).toBe(1);
  });

  it("STACKS onto an unexpired period rather than restarting it", () => {
    // Same rule settlement uses, so the date quoted before payment is the date
    // written after it.
    const now = new Date("2026-08-09T00:00:00Z");
    const end = new Date("2026-11-09T00:00:00Z");
    const out = periodEndAfter(BILLING_CYCLES.YEAR, 1, now, end);
    expect(out.toISOString().slice(0, 10)).toBe("2027-08-09");
  });

  it("starts from NOW when the current period has already lapsed", () => {
    // A school returning after a lapse buys forward, not backdated — otherwise
    // they would pay for time that has already passed.
    const now = new Date("2026-08-09T00:00:00Z");
    const lapsed = new Date("2026-01-01T00:00:00Z");
    const out = periodEndAfter(BILLING_CYCLES.TERM, 1, now, lapsed);
    expect(out.toISOString().slice(0, 10)).toBe("2026-11-09");
  });

  it("five years bought at once lands where five bought in a row would", () => {
    // The point of the multiplier: same destination, one charge, no race.
    const now = new Date("2026-08-09T00:00:00Z");
    const atOnce = periodEndAfter(BILLING_CYCLES.YEAR, 5, now, null);
    let stepwise: Date | null = null;
    for (let i = 0; i < 5; i++) stepwise = periodEndAfter(BILLING_CYCLES.YEAR, 1, now, stepwise);
    expect(atOnce.toISOString()).toBe(stepwise!.toISOString());
  });

  it("a TRUEUP-sized period count never moves the period backwards", () => {
    const now = new Date("2026-08-09T00:00:00Z");
    const end = new Date("2030-01-01T00:00:00Z");
    expect(periodEndAfter(BILLING_CYCLES.MONTH, 1, now, end).getTime()).toBeGreaterThan(end.getTime());
  });
});

describe("settlement serialisation", () => {
  it("locks the school's subscription row before touching the period", async () => {
    // The regression guard for the measured defect. Without this the read of
    // currentPeriodEnd and the write of base+months are separate statements
    // under READ COMMITTED, so concurrent charges overwrite each other.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../src/billing/billing.service.ts"), "utf8");
    const lockAt = src.indexOf('FOR UPDATE`');
    const readAt = src.indexOf("const sub = await tx.schoolSubscription.findFirst({ where: { schoolId } });");
    expect(lockAt).toBeGreaterThan(-1);
    // The lock has to come FIRST — after the read it protects nothing.
    expect(lockAt).toBeLessThan(readAt);
    expect(src.slice(lockAt - 200, lockAt)).toContain("school_subscription");
  });
});

describe("the charge ceiling", () => {
  it("is BELOW the int4 limit the column actually imposes", async () => {
    const { MAX_CHARGE_MINOR } = await import("@sms/types");
    // Headroom on purpose: the guard has to fire before the driver does, or
    // the school sees a 500 instead of a sentence they can act on.
    expect(MAX_CHARGE_MINOR).toBeLessThan(2_147_483_647);
  });

  it("is a real limit on ORDINARY plans, not just multi-year ones", async () => {
    const { MAX_CHARGE_MINOR, PLAN_PRICING, PLANS, computeSubscriptionPriceMinor, BILLING_CYCLES } = await import(
      "@sms/types"
    );
    // At the DEFAULT ENTERPRISE rate a single academic year passes the cap
    // somewhere around 3,500 students — sooner on an operator-raised price.
    // So a large school could not buy a normal annual plan either, and this
    // pins that the ceiling is understood rather than rediscovered in prod.
    const bigSchool = computeSubscriptionPriceMinor(
      PLANS.ENTERPRISE,
      5_000,
      BILLING_CYCLES.YEAR,
      PLAN_PRICING,
    );
    expect(bigSchool).toBeGreaterThan(MAX_CHARGE_MINOR);
    // and a mid-sized school is comfortably UNDER it, so the guard is not
    // quietly blocking ordinary business
    expect(
      computeSubscriptionPriceMinor(PLANS.ENTERPRISE, 1_000, BILLING_CYCLES.YEAR, PLAN_PRICING),
    ).toBeLessThan(MAX_CHARGE_MINOR);
  });
});

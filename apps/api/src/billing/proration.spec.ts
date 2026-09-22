import {
  MIN_CHARGE_MINOR,
  PLAN_PRICING,
  accrueSeatArrearsMinor,
  computeSubscriptionPriceMinor,
  perSeatDailyMinor,
  computeTrueUpMinor,
  prorationCreditMinor,
  remainingPeriodRatio,
} from "@sms/types";

const DAY = 24 * 3600 * 1000;
const now = new Date("2026-09-01T00:00:00Z");

describe("remainingPeriodRatio", () => {
  it("is 0 when lapsed and capped at 1", () => {
    expect(remainingPeriodRatio("TERM", new Date(now.getTime() - DAY), now)).toBe(0);
    expect(remainingPeriodRatio("TERM", new Date(now.getTime() + 365 * DAY), now)).toBe(1);
  });
  it("is ~half a term with 45 of 90 days left", () => {
    const r = remainingPeriodRatio("TERM", new Date(now.getTime() + 45 * DAY), now);
    expect(r).toBeCloseTo(0.5, 2);
  });
});

describe("prorationCreditMinor", () => {
  it("credits the remaining fraction of the LAST paid amount", () => {
    const credit = prorationCreditMinor(900_000, "TERM", new Date(now.getTime() + 45 * DAY), now);
    expect(credit).toBe(450_000);
  });
  it("is zero when lapsed, unpaid, or period unknown", () => {
    expect(prorationCreditMinor(900_000, "TERM", new Date(now.getTime() - DAY), now)).toBe(0);
    expect(prorationCreditMinor(null, "TERM", new Date(now.getTime() + DAY), now)).toBe(0);
    expect(prorationCreditMinor(900_000, "TERM", null, now)).toBe(0);
  });
  it("never exceeds what was paid", () => {
    expect(prorationCreditMinor(900_000, "TERM", new Date(now.getTime() + 365 * DAY), now)).toBe(900_000);
  });
});

/** A three-term school. The parameter is REQUIRED precisely so a test cannot
 *  quietly assume the platform's home calendar; other counts are covered in
 *  billing-pricing.spec. */
const TERMS = 3;

describe("computeTrueUpMinor", () => {
  const end = new Date(now.getTime() + 45 * DAY); // half a TERM left

  it("prices only the EXTRA seats, prorated to the time left", () => {
    const q = computeTrueUpMinor("STANDARD", 400, 450, "TERM", TERMS, end, now);
    expect(q).not.toBeNull();
    expect(q!.extraSeats).toBe(50);
    const full = computeSubscriptionPriceMinor("STANDARD", 50, "TERM", TERMS);
    expect(q!.amountMinor).toBe(Math.round(full * remainingPeriodRatio("TERM", end, now)));
  });

  it("accrueSeatArrearsMinor meters extra seat-days at the plan's daily rate", () => {
    // 500 extra seats for exactly 1 day, metered at the rate the school is
    // ACTUALLY on: a TERM buyer's per-seat term price spread over the term's
    // 3 × 30 days. A session buyer accrues at the discounted session rate —
    // that is the point of taking the rate from the cycle rather than from a
    // notional monthly figure nobody is charged.
    const daily = perSeatDailyMinor(PLAN_PRICING.STANDARD.perSeatSessionMinor, "TERM", TERMS);
    expect(accrueSeatArrearsMinor("STANDARD", 1000, 1500, DAY, "TERM", TERMS)).toBe(Math.round(500 * daily));
    // A week accrues 7× a day (rounding aside).
    const week = accrueSeatArrearsMinor("STANDARD", 1000, 1500, 7 * DAY, "TERM", TERMS);
    expect(week).toBe(Math.round(500 * daily * 7));
  });

  it("accrual is zero for shrinking rosters, unbilled subs, or no elapsed time", () => {
    expect(accrueSeatArrearsMinor("STANDARD", 1000, 900, DAY, "TERM", TERMS)).toBe(0); // seats floor, no credits
    expect(accrueSeatArrearsMinor("STANDARD", null, 1500, DAY, "TERM", TERMS)).toBe(0); // never seat-billed
    expect(accrueSeatArrearsMinor("STANDARD", 1000, 1500, 0, "TERM", TERMS)).toBe(0);
    expect(accrueSeatArrearsMinor("STANDARD", 1000, 1500, -DAY, "TERM", TERMS)).toBe(0);
  });

  it("is null when seats shrank, never billed, lapsed, or below the charge floor", () => {
    expect(computeTrueUpMinor("STANDARD", 400, 390, "TERM", TERMS, end, now)).toBeNull();
    expect(computeTrueUpMinor("STANDARD", null, 450, "TERM", TERMS, end, now)).toBeNull();
    expect(computeTrueUpMinor("STANDARD", 400, 450, "TERM", TERMS, new Date(now.getTime() - DAY), now)).toBeNull();
    // 1 extra seat for a sliver of time is under the gateway floor.
    const tiny = computeTrueUpMinor("STANDARD", 400, 401, "TERM", TERMS, new Date(now.getTime() + 3600_000), now);
    expect(tiny).toBeNull();
    expect(MIN_CHARGE_MINOR).toBeGreaterThan(0);
  });
});

import {
  MIN_CHARGE_MINOR,
  PLAN_PRICING,
  accrueSeatArrearsMinor,
  computeSubscriptionPriceMinor,
  computeTrueUpMinor,
  prorationCreditMinor,
  remainingPeriodRatio,
} from "@sms/types";

const DAY = 24 * 3600 * 1000;
const now = new Date("2026-09-01T00:00:00Z");

describe("remainingPeriodRatio", () => {
  it("is 0 when lapsed and capped at 1", () => {
    expect(remainingPeriodRatio("TERM", new Date(now.getTime() - DAY), now)).toBe(0);
    expect(remainingPeriodRatio("MONTH", new Date(now.getTime() + 365 * DAY), now)).toBe(1);
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

describe("computeTrueUpMinor", () => {
  const end = new Date(now.getTime() + 45 * DAY); // half a TERM left

  it("prices only the EXTRA seats, prorated to the time left", () => {
    const q = computeTrueUpMinor("STANDARD", 400, 450, "TERM", end, now);
    expect(q).not.toBeNull();
    expect(q!.extraSeats).toBe(50);
    const full = computeSubscriptionPriceMinor("STANDARD", 50, "TERM");
    expect(q!.amountMinor).toBe(Math.round(full * remainingPeriodRatio("TERM", end, now)));
  });

  it("accrueSeatArrearsMinor meters extra seat-days at the plan's daily rate", () => {
    // 500 extra seats for exactly 1 day = 500 × monthly/30.
    const daily = PLAN_PRICING.STANDARD.perSeatMonthlyMinor / 30;
    expect(accrueSeatArrearsMinor("STANDARD", 1000, 1500, DAY)).toBe(Math.round(500 * daily));
    // A week accrues 7× a day (rounding aside).
    const week = accrueSeatArrearsMinor("STANDARD", 1000, 1500, 7 * DAY);
    expect(week).toBe(Math.round(500 * daily * 7));
  });

  it("accrual is zero for shrinking rosters, unbilled subs, or no elapsed time", () => {
    expect(accrueSeatArrearsMinor("STANDARD", 1000, 900, DAY)).toBe(0); // seats floor, no credits
    expect(accrueSeatArrearsMinor("STANDARD", null, 1500, DAY)).toBe(0); // never seat-billed
    expect(accrueSeatArrearsMinor("STANDARD", 1000, 1500, 0)).toBe(0);
    expect(accrueSeatArrearsMinor("STANDARD", 1000, 1500, -DAY)).toBe(0);
  });

  it("is null when seats shrank, never billed, lapsed, or below the charge floor", () => {
    expect(computeTrueUpMinor("STANDARD", 400, 390, "TERM", end, now)).toBeNull();
    expect(computeTrueUpMinor("STANDARD", null, 450, "TERM", end, now)).toBeNull();
    expect(computeTrueUpMinor("STANDARD", 400, 450, "TERM", new Date(now.getTime() - DAY), now)).toBeNull();
    // 1 extra seat for a sliver of time is under the gateway floor.
    const tiny = computeTrueUpMinor("STANDARD", 400, 401, "TERM", new Date(now.getTime() + 3600_000), now);
    expect(tiny).toBeNull();
    expect(MIN_CHARGE_MINOR).toBeGreaterThan(0);
  });
});

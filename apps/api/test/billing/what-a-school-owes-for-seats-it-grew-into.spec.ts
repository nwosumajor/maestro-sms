// =============================================================================
// Earned, unbilled, and on no screen
// =============================================================================
// A school buys a seat count and its roll grows mid-period. The nightly sweep
// meters the difference in seat-days onto `school_subscription.seatArrearsMinor`
// and it is collected either when the school tops up or automatically on its
// next renewal. That machinery is sound — this file pins it, because it is the
// answer to "the school paid for 400 and enrolled 500 more a week later".
//
// What was NOT sound is that the money was invisible. The operator's attention
// queue flagged WHICH schools had arrears and never said how much — a fact an
// owner can do nothing with, since whether to ring a school about unbilled
// growth is a decision about an amount. And nothing anywhere added it up, so
// "what are we owed?" had no answer in the product at all.
//
// And one part of it is uncollectable. Every collection point refuses
// cross-currency arithmetic — rightly: there is no FX rate in this platform and
// inventing one to move a debt would be worse than the debt. But a school that
// moves from a naira tier to USD-priced ENTERPRISE leaves its naira arrears
// behind, skipped by the top-up and by every renewal, silently and for ever.
// Naming it is the fix; converting it is not.
// =============================================================================

import { PLANS, PLAN_PRICING, accrueSeatArrearsMinor, computeTrueUpMinor } from "@sms/types";

const DAY = 24 * 3600 * 1000;
const perSeatMonth = PLAN_PRICING.ENTERPRISE.perSeatMonthlyMinor;

describe("400 seats paid, 500 more pupils a week later", () => {
  it("meters the extra seats from the day they arrive, not from the renewal", () => {
    // The whole point of the meter: delay must not discount the bill. Seven
    // days of 500 extra seats at the ENTERPRISE per-seat daily rate.
    const week = accrueSeatArrearsMinor(PLANS.ENTERPRISE, 400, 900, 7 * DAY);
    expect(week).toBe(Math.round(500 * (perSeatMonth / 30) * 7));
    expect(week).toBeGreaterThan(0);
  });

  it("keeps counting the longer nobody settles", () => {
    // A forward-only quote SHRINKS as the term runs down, so waiting was worth
    // money to the school. The meter runs the other way.
    const week = accrueSeatArrearsMinor(PLANS.ENTERPRISE, 400, 900, 7 * DAY);
    const month = accrueSeatArrearsMinor(PLANS.ENTERPRISE, 400, 900, 30 * DAY);
    expect(month).toBeGreaterThan(week);
  });

  it("charges nothing for a roll that SHRINKS", () => {
    // Billed seats are a floor. A school that loses pupils mid-period accrues
    // nothing and is credited nothing — the seats were bought.
    expect(accrueSeatArrearsMinor(PLANS.ENTERPRISE, 400, 250, 30 * DAY)).toBe(0);
  });

  it("offers a top-up that covers only the time LEFT", () => {
    // The forward half. Paid for 400, carrying 900, 83 days left of a term.
    const end = new Date(Date.now() + 83 * DAY);
    const q = computeTrueUpMinor(PLANS.ENTERPRISE, 400, 900, "TERM", end, new Date());
    expect(q?.extraSeats).toBe(500);
    // Less than a whole term at 500 seats, because most of the term remains but
    // not all of it.
    expect(q!.amountMinor).toBeLessThan(500 * perSeatMonth * 3);
    expect(q!.amountMinor).toBeGreaterThan(0);
  });

  it("offers no top-up once the period is over — the meter carries it instead", () => {
    // Nothing forward to sell. The arrears are still owed and ride the renewal.
    expect(computeTrueUpMinor(PLANS.ENTERPRISE, 400, 900, "TERM", new Date(Date.now() - DAY), new Date())).toBeNull();
  });

  it("offers no top-up for a school that never bought seats", () => {
    // A trial or a comped subscription has no billed seat count to grow past.
    expect(computeTrueUpMinor(PLANS.ENTERPRISE, null, 900, "TERM", new Date(Date.now() + 30 * DAY), new Date())).toBeNull();
    expect(accrueSeatArrearsMinor(PLANS.ENTERPRISE, null, 900, 30 * DAY)).toBe(0);
  });
});

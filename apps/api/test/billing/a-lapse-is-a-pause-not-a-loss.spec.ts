// =============================================================================
// What a school loses when it stops paying, and gets back when it pays
// =============================================================================
// The lever is `effectivePlan`, and the property that makes the whole thing
// safe is that the PURCHASED plan is never overwritten: delinquency changes what
// is ENFORCED, not what was bought, so paying restores the tier with no repair
// step and no re-resolving of anything.
//
// Verified live end to end alongside these:
//   paid ENTERPRISE      27 modules   /hr 200  /fees 200
//   period lapsed, swept PAST_DUE, still ENTERPRISE during grace   /hr 200
//   past grace           10 modules   /hr 404  /fees 200
//   paid again           27 modules   /hr 200  — and quoted at the CURRENT
//                        roll (901 seats), not the 400 it lapsed on
// =============================================================================

import { PLANS, SUBSCRIPTION_GRACE_DAYS, SUBSCRIPTION_STATUS, effectivePlan, resolveModules } from "@sms/types";

const DAY = 24 * 3600 * 1000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY);
const NOW = new Date();

describe("a subscription running out", () => {
  it("keeps the full tier while it is ACTIVE, whatever the period says", () => {
    // The period ending is not itself the downgrade: the nightly sweep flips the
    // STATUS, and until it does the school is not treated as delinquent. That
    // makes the sweep load-bearing, which is why it counts and reports failures.
    expect(effectivePlan(PLANS.ENTERPRISE, SUBSCRIPTION_STATUS.ACTIVE, at(-30), SUBSCRIPTION_GRACE_DAYS, NOW)).toBe(
      PLANS.ENTERPRISE,
    );
  });

  it("keeps the full tier through the grace window", () => {
    // The window exists so a late payment is not punished by a school losing
    // its timetable on a Monday morning.
    expect(effectivePlan(PLANS.ENTERPRISE, SUBSCRIPTION_STATUS.PAST_DUE, at(-1), 7, NOW)).toBe(PLANS.ENTERPRISE);
  });

  it("falls to the STANDARD floor once the grace is spent", () => {
    expect(effectivePlan(PLANS.ENTERPRISE, SUBSCRIPTION_STATUS.PAST_DUE, at(-30), 7, NOW)).toBe(PLANS.STANDARD);
  });

  it("honours a school's OWN grace window over the platform default", () => {
    // The operator can lengthen it for a school that has asked for time.
    expect(effectivePlan(PLANS.ENTERPRISE, SUBSCRIPTION_STATUS.PAST_DUE, at(-30), 60, NOW)).toBe(PLANS.ENTERPRISE);
  });

  it("gives a CANCELLED subscription no grace at all", () => {
    // Cancelling is a decision, not a missed payment. It runs to the end of the
    // period that was paid for and stops there.
    expect(effectivePlan(PLANS.ENTERPRISE, SUBSCRIPTION_STATUS.CANCELED, at(-1), 30, NOW)).toBe(PLANS.STANDARD);
    expect(effectivePlan(PLANS.ENTERPRISE, SUBSCRIPTION_STATUS.CANCELED, at(1), 30, NOW)).toBe(PLANS.ENTERPRISE);
  });

  it("leaves the floor's own modules alone — a lapse is not an eviction", () => {
    // The school keeps teaching, registering and billing. That is deliberate:
    // fees is where the platform earns its take-rate, and cutting a delinquent
    // school off from collecting money is how it stays delinquent.
    const floor = resolveModules(PLANS.STANDARD);
    expect(floor).toContain("fees");
    expect(floor).toContain("attendance");
    expect(floor).not.toContain("hr");
  });
});

describe("and paying again", () => {
  it("restores the tier immediately, because the purchase was never overwritten", () => {
    // The stored plan stayed ENTERPRISE throughout. Settlement sets the status
    // back to ACTIVE and the same pure function returns the full tier — there is
    // no downgrade to undo and no state to repair.
    expect(effectivePlan(PLANS.ENTERPRISE, SUBSCRIPTION_STATUS.ACTIVE, at(90), SUBSCRIPTION_GRACE_DAYS, NOW)).toBe(
      PLANS.ENTERPRISE,
    );
    expect(resolveModules(PLANS.ENTERPRISE)).toContain("hr");
  });
});

// =============================================================================
// A pupil who enrols mid-period costs what a pupil who was there at renewal costs
// =============================================================================
// Mid-period seat growth is billed two ways and they must add up to the same
// thing a renewal seat is billed:
//
//   arrears  — the seat-days ALREADY elapsed, metered daily
//   true-up  — the time REMAINING, quoted forward
//
// ADD-ONS WERE MISSING FROM BOTH. At renewal every seat pays the tier PLUS the
// school's add-on modules; mid-period growth was priced at the bare tier rate.
// So a pupil who arrived in week two used the hostel module all term and the
// school was never charged for it — measured on the demo school at 601 extra
// seats, NGN 225,375 of hostel access unbilled for the term, and the discrepancy
// grew with every school that bought an add-on.
//
// Neither `computeTrueUpMinor` nor `accrueSeatArrearsMinor` took an `overrides`
// argument, so there was no way to pass it and nothing to notice.
// =============================================================================

import {
  BILLING_CYCLES,
  CALENDAR_TEMPLATES,
  MODULES,
  MODULE_ADDON_PRICING,
  PLANS,
  PLAN_PRICING,
  accrueSeatArrearsMinor,
  computeSubscriptionPriceMinor,
  computeTrueUpMinor,
  termsInSession,
} from "@sms/types";

const DAY = 86_400_000;
/** The tier that does NOT include hostel, so the override is genuinely billable. */
const PLAN = PLANS.STANDARD;
const ADDON = MODULES.HOSTEL;
const OVERRIDES = { enabled: [ADDON] };

describe("a mid-period seat is billed like a renewal seat", () => {
  it.each(Object.keys(CALENDAR_TEMPLATES))(
    "%s: arrears + true-up equals a full renewal seat, add-ons included",
    (template) => {
      const terms = termsInSession(template);
      for (const cycle of Object.values(BILLING_CYCLES)) {
        const periodDays = (cycle === BILLING_CYCLES.TERM ? 3 : 9) * 30;
        // What ONE seat costs at renewal on this plan WITH the add-on.
        const renewal = computeSubscriptionPriceMinor(PLAN, 1, cycle, terms, PLAN_PRICING, OVERRIDES);

        // The same seat arriving partway through: metered for the days gone,
        // quoted forward for the days left.
        const elapsed = Math.floor(periodDays / 2);
        const now = new Date();
        const end = new Date(now.getTime() + (periodDays - elapsed) * DAY);
        const arrears = accrueSeatArrearsMinor(
          PLAN, 100, 101, elapsed * DAY, cycle, terms, PLAN_PRICING, OVERRIDES,
        );
        const fwd = computeTrueUpMinor(
          PLAN, 100, 101, cycle, terms, end, now, PLAN_PRICING, OVERRIDES,
        );
        const total = arrears + (fwd?.amountMinor ?? 0);

        // Within a kobo per side for integer rounding — not a percentage, which
        // would hide a missing add-on on a cheap tier.
        const where = `${template}/${cycle}`;
        expect([where, Math.abs(total - renewal) <= 2]).toEqual([where, true]);
      }
    },
  );

  it("charges MORE than the bare tier — the add-on is actually in there", () => {
    // The mutation this exists to catch: dropping the overrides argument makes
    // every assertion above still "pass" arithmetically against a tier-only
    // renewal, so the suite must also pin that add-ons move the number.
    const terms = 3;
    const now = new Date();
    const end = new Date(now.getTime() + 90 * DAY);

    const withAddon = computeTrueUpMinor(PLAN, 100, 101, "TERM", terms, end, now, PLAN_PRICING, OVERRIDES);
    const tierOnly = computeTrueUpMinor(PLAN, 100, 101, "TERM", terms, end, now, PLAN_PRICING);
    expect(withAddon!.amountMinor).toBeGreaterThan(tierOnly!.amountMinor);

    const arrWith = accrueSeatArrearsMinor(PLAN, 100, 101, 90 * DAY, "TERM", terms, PLAN_PRICING, OVERRIDES);
    const arrOnly = accrueSeatArrearsMinor(PLAN, 100, 101, 90 * DAY, "TERM", terms, PLAN_PRICING);
    expect(arrWith).toBeGreaterThan(arrOnly);

    // And the gap is the add-on's own share of the cycle, not some other number.
    const addonTermShare = Math.round((MODULE_ADDON_PRICING[ADDON]! * 100) / 85 / terms);
    expect(Math.abs(withAddon!.amountMinor - tierOnly!.amountMinor - addonTermShare)).toBeLessThanOrEqual(2);
  });

  it("a module the TIER already includes is never charged twice", () => {
    // ULTIMATE contains hostel, so a stale override must add nothing — the same
    // absorption rule the renewal charge keeps.
    const terms = 3;
    const now = new Date();
    const end = new Date(now.getTime() + 90 * DAY);
    const plain = computeTrueUpMinor(PLANS.ULTIMATE, 100, 101, "TERM", terms, end, now);
    const stale = computeTrueUpMinor(PLANS.ULTIMATE, 100, 101, "TERM", terms, end, now, PLAN_PRICING, OVERRIDES);
    expect(stale!.amountMinor).toBe(plain!.amountMinor);
  });
});

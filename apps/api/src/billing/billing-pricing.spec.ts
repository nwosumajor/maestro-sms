// =============================================================================
// Platform billing — pure pricing + effective-plan unit tests (no DB)
// =============================================================================
// Pins the two pure functions the whole revenue layer rests on:
//   - computeSubscriptionPriceMinor: the SESSION price is stored, the TERM price
//     is derived from it and the school's own term count
//   - effectivePlan: status-driven downgrade that NEVER mutates the purchased
//     plan (the STANDARD floor while past-due beyond grace / canceled past period end)
// =============================================================================

import {
  BILLING_CYCLES,
  CALENDAR_TEMPLATES,
  PLANS,
  PLAN_PRICING,
  SESSION_DISCOUNT_PERCENT,
  SUBSCRIPTION_GRACE_DAYS,
  SUBSCRIPTION_STATUS,
  computeSubscriptionPriceMinor,
  effectivePlan,
  perSeatCycleMinor,
  termsInSession,
} from "@sms/types";

/** Every calendar shape the platform ships, as term counts. */
const TERM_COUNTS = Object.keys(CALENDAR_TEMPLATES).map((k) => [k, termsInSession(k)] as const);

describe("computeSubscriptionPriceMinor", () => {
  it("charges the stored session price for a SESSION, whatever the calendar", () => {
    const seats = 400;
    const session = PLAN_PRICING.STANDARD.perSeatSessionMinor;
    // THE POINT OF ANCHORING ON THE SESSION: a year costs the same everywhere.
    // A US two-semester school and a four-quarter school pay what a Nigerian
    // three-term school pays, because a year is a year.
    for (const [, terms] of TERM_COUNTS) {
      expect(computeSubscriptionPriceMinor(PLANS.STANDARD, seats, BILLING_CYCLES.SESSION, terms)).toBe(session * seats);
    }
  });

  it("derives the TERM price so a whole year of terms is exactly 15% dearer — in EVERY calendar", () => {
    const seats = 250;
    // This is the promise the homepage makes, asserted as arithmetic rather
    // than trusted to a constant somebody keeps true. It must hold for 2, 3 and
    // 4 terms alike: a literal 3 anywhere in the derivation breaks two of them.
    expect(TERM_COUNTS.length).toBeGreaterThanOrEqual(4); // the walk found something
    for (const plan of Object.values(PLANS)) {
      for (const [key, terms] of TERM_COUNTS) {
        const perTerm = computeSubscriptionPriceMinor(plan, seats, BILLING_CYCLES.TERM, terms);
        const perSession = computeSubscriptionPriceMinor(plan, seats, BILLING_CYCLES.SESSION, terms);
        const wholeYearInTerms = perTerm * terms;
        const saving = 1 - perSession / wholeYearInTerms;
        // Within a kobo of 15% — the only slack is integer rounding per seat.
        expect([key, plan, Math.abs(saving - SESSION_DISCOUNT_PERCENT / 100) < 0.0005]).toEqual([key, plan, true]);
        expect(perSession).toBeLessThan(wholeYearInTerms);
      }
    }
  });

  it("a two-semester school pays MORE per term than a three-term school, and the same per year", () => {
    // The failure this model exists to prevent: dividing a session by a hard
    // coded 3 would bill a US school for a term it does not have.
    const seats = 100;
    const two = computeSubscriptionPriceMinor(PLANS.PREMIUM, seats, BILLING_CYCLES.TERM, 2);
    const three = computeSubscriptionPriceMinor(PLANS.PREMIUM, seats, BILLING_CYCLES.TERM, 3);
    const four = computeSubscriptionPriceMinor(PLANS.PREMIUM, seats, BILLING_CYCLES.TERM, 4);
    expect(two).toBeGreaterThan(three);
    expect(three).toBeGreaterThan(four);
    // ...and each school's year still totals the same, bar rounding.
    for (const [terms, perTerm] of [[2, two], [3, three], [4, four]] as const) {
      expect(Math.abs(perTerm * terms - three * 3)).toBeLessThan(terms * seats);
    }
  });

  it("prices are integers — kobo and cents are never fractional", () => {
    for (const [, terms] of TERM_COUNTS) {
      for (const cycle of Object.values(BILLING_CYCLES)) {
        const v = computeSubscriptionPriceMinor(PLANS.ULTIMATE, 337, cycle, terms);
        expect(Number.isInteger(v)).toBe(true);
      }
    }
    // An odd session price exercises the rounding path in the term derivation.
    const odd = { ...PLAN_PRICING, STANDARD: { perSeatSessionMinor: 33_333 } };
    expect(Number.isInteger(computeSubscriptionPriceMinor(PLANS.STANDARD, 3, BILLING_CYCLES.TERM, 3, odd))).toBe(true);
  });

  it("clamps seats to at least 1 (never charges for 0 students)", () => {
    const session = PLAN_PRICING.ENTERPRISE.perSeatSessionMinor;
    expect(computeSubscriptionPriceMinor(PLANS.ENTERPRISE, 0, BILLING_CYCLES.SESSION, 3)).toBe(session);
    expect(computeSubscriptionPriceMinor(PLANS.ENTERPRISE, -5, BILLING_CYCLES.SESSION, 3)).toBe(session);
  });

  it("higher tiers cost more per seat (STANDARD < PREMIUM < ULTIMATE < ENTERPRISE)", () => {
    const std = PLAN_PRICING.STANDARD.perSeatSessionMinor;
    const prem = PLAN_PRICING.PREMIUM.perSeatSessionMinor;
    const ult = PLAN_PRICING.ULTIMATE.perSeatSessionMinor;
    const ent = PLAN_PRICING.ENTERPRISE.perSeatSessionMinor;
    expect(std).toBeLessThan(prem);
    expect(prem).toBeLessThan(ult);
    expect(ult).toBeLessThan(ent);
  });

  it("a term count of zero or nonsense cannot produce a free or infinite term", () => {
    // Defensive: the divisor is clamped, so a school whose template somehow
    // resolves to nothing is billed as a single-term school rather than
    // dividing by zero and charging Infinity.
    const v = perSeatCycleMinor(PLAN_PRICING.STANDARD.perSeatSessionMinor, BILLING_CYCLES.TERM, 0);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });
});

describe("effectivePlan", () => {
  const now = new Date("2026-06-27T00:00:00Z");
  const future = new Date("2026-09-01T00:00:00Z");
  const justPast = new Date("2026-06-25T00:00:00Z"); // 2 days ago (within grace)
  const longPast = new Date("2026-06-01T00:00:00Z"); // 26 days ago (beyond grace)

  // Per-school grace override (operator-set, bounded 0..GRACE_DAYS_MAX at the API).
  it("a LONGER per-school grace keeps the plan where the default would downgrade", () => {
    // 26 days past due: default 7-day grace -> STANDARD; a 30-day override -> keeps it.
    expect(effectivePlan(PLANS.ENTERPRISE, SUBSCRIPTION_STATUS.PAST_DUE, longPast, SUBSCRIPTION_GRACE_DAYS, now)).toBe(
      PLANS.STANDARD,
    );
    expect(effectivePlan(PLANS.ENTERPRISE, SUBSCRIPTION_STATUS.PAST_DUE, longPast, 30, now)).toBe(PLANS.ENTERPRISE);
  });

  it("a ZERO per-school grace downgrades immediately once past due", () => {
    // 2 days past due: default grace still covers it; grace 0 does not.
    expect(effectivePlan(PLANS.ULTIMATE, SUBSCRIPTION_STATUS.PAST_DUE, justPast, SUBSCRIPTION_GRACE_DAYS, now)).toBe(
      PLANS.ULTIMATE,
    );
    expect(effectivePlan(PLANS.ULTIMATE, SUBSCRIPTION_STATUS.PAST_DUE, justPast, 0, now)).toBe(PLANS.STANDARD);
  });

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
  it("EVERY tier sells in both currencies — ENTERPRISE included", () => {
    // ENTERPRISE used to be USD-only, on the reasoning that it targets
    // international schools. The platform's only live card rail is a Paystack
    // account not enabled for USD, so that made the top tier unbuyable: a
    // Nigerian group had no way to pay for it, and the NGN price already
    // existed. A display preference must never gate a sale.
    // Asserted as EVERY tier sells EVERY sellable currency, rather than against a
    // typed-out pair — adding GHS made that literal wrong while the property it
    // guards (a display preference must never gate a sale) was untouched.
    const sellable = planCurrencies(PLANS.STANDARD);
    expect(sellable).toContain(CURRENCIES.NGN);
    expect(sellable).toContain(CURRENCIES.USD);
    expect(sellable).toContain(CURRENCIES.GHS);
    for (const plan of [PLANS.STANDARD, PLANS.PREMIUM, PLANS.ULTIMATE, PLANS.ENTERPRISE]) {
      expect({ plan, sells: planCurrencies(plan) }).toEqual({ plan, sells: sellable });
    }
  });

  it("DISPLAYS every tier in one currency — a price list a reader can compare", () => {
    // ENTERPRISE used to present in dollars beside three naira tiers, so the
    // public list read as four prices in two currencies and the top tier was
    // the one nobody could place against the others.
    for (const plan of Object.values(PLANS)) {
      expect([plan, defaultCurrencyFor(plan)]).toEqual([plan, CURRENCIES.NGN]);
    }
  });

  it("but still SELLS every tier in every priced currency — display is not settlement", () => {
    expect(planCurrencies(PLANS.ENTERPRISE)).toContain(CURRENCIES.NGN);
    expect(planCurrencies(PLANS.ENTERPRISE)).toContain(CURRENCIES.USD);
  });

  it("separates what the platform can EXPRESS from what it can SELL IN", () => {
    // Two different questions, and conflating them ships a checkout that cannot
    // complete. `isCurrency` is the type gate — currencies the rails could settle;
    // `planCurrencies` is what actually has a price list today.
    for (const c of ["NGN", "USD", "GHS", "KES", "ZAR", "GBP", "EUR"]) {
      expect({ c, expressible: isCurrency(c) }).toEqual({ c, expressible: true });
    }
    expect(isCurrency("XOF")).toBe(false); // a FEE currency, not a billing one
    expect(isCurrency(undefined)).toBe(false);

    // SOLD IN is still the narrower set, and it is exactly the currencies that
    // have a price list — GHS joined by GAINING one, which is the point: opening
    // a market is a price list, not a code change.
    expect(planCurrencies(PLANS.STANDARD).sort()).toEqual(["GHS", "NGN", "USD"]);
    expect(planCurrencies(PLANS.ENTERPRISE).sort()).toEqual(["GHS", "NGN", "USD"]);
    // …and the two sets are still different, which is the whole distinction.
    expect(isCurrency("KES")).toBe(true);
    expect(planCurrencies(PLANS.STANDARD)).not.toContain("KES");
  });

  it("USD pricing computes in cents with the USD table", () => {
    const seats = 500;
    expect(
      computeSubscriptionPriceMinor(PLANS.ENTERPRISE, seats, BILLING_CYCLES.SESSION, 3, PLAN_PRICING_USD),
    ).toBe(PLAN_PRICING_USD.ENTERPRISE.perSeatSessionMinor * seats);
  });
});

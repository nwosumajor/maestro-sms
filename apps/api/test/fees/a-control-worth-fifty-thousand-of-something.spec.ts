// =============================================================================
// A two-person rule denominated in a currency the school does not use
// =============================================================================
// `PAYMENT_APPROVAL_THRESHOLD_MINOR = 5_000_000` is kobo: ₦50,000, the figure
// CLAUDE.md quotes and the owner-facing documents promise. It was compared
// against every school's payments whatever `school.currency` says, and
// `school.currency` is a free-form ISO code — any of the twenty-nine catalogued.
//
//     NGN   ₦50,000         the figure intended
//     GBP   £50,000         the control is effectively OFF
//     GHS   GHS 50,000      likewise
//     XOF   5,000,000 F     zero-decimal: a hundred times too lax
//
// A maker-checker rule that never fires is not a weaker control, it is no
// control — and it fails SILENTLY, while /fees and /help go on saying large
// payments need a second signature. This platform holds no FX rate, and
// inventing one to convert a control threshold would be worse than the bug.
// So the school states its own figure and an unset one FAILS TIGHT.
//
// THE LIBRARY FINE IS THE SAME BUG AND THE OPPOSITE FIX. `FINE_PER_DAY_MINOR`
// is ₦50 a day and lands on a family's fee invoice; in a British school that is
// £50 a day for an overdue reading book. An unset CHARGE resolves to ZERO.
//
// Which way "more restrictive" points depends on who the rule is pointed at:
// an unset control that relaxes stops protecting, an unset charge that guesses
// bills a family. Golden Rule #7, read properly.
// =============================================================================

import {
  PAYMENT_APPROVAL_THRESHOLD_MINOR,
  effectiveLibraryFinePerDayMinor,
  effectivePaymentApprovalThresholdMinor,
  paymentNeedsApproval,
} from "@sms/types";

const HOME = PAYMENT_APPROVAL_THRESHOLD_MINOR; // ₦50,000 in kobo
const threshold = (currency: string | null, configuredMinor: number | null = null) =>
  effectivePaymentApprovalThresholdMinor({ configuredMinor, currency });
const fine = (currency: string | null, configuredMinor: number | null = null) =>
  effectiveLibraryFinePerDayMinor({ configuredMinor, currency, homeDefaultMinor: 5000 });

describe("the approval threshold a school actually gets", () => {
  it("is unchanged for a school on the platform's own currency", () => {
    // Nothing moves for anyone already live — the point of a fail-safe that
    // depends on the currency rather than on merely being unset.
    expect(threshold("NGN")).toBe(HOME);
    expect(threshold(null)).toBe(HOME); // null currency = the home country
  });

  it("is ZERO — every payment reviewed — for any other currency, until set", () => {
    for (const c of ["GBP", "GHS", "USD", "XOF", "KES"]) {
      expect([c, threshold(c)]).toEqual([c, 0]);
    }
  });

  it("is whatever the school states, once it states it", () => {
    // £250 in pence: the school's own judgement of "a large sum", in its own
    // money, which is the only place that judgement can come from.
    expect(threshold("GBP", 25_000)).toBe(25_000);
    // Including a deliberate zero: "review everything" is a legitimate policy.
    expect(threshold("GBP", 0)).toBe(0);
  });

  it("does not care about the case of the code", () => {
    expect(threshold("ngn")).toBe(HOME);
  });
});

describe("what that means at the moment a payment is recorded", () => {
  it("a British school reviews a £300 payment instead of waving it through", () => {
    // 30,000 pence. Against the old naira constant this was nowhere near
    // 5,000,000 and posted immediately.
    const gbp = threshold("GBP");
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: 30_000, recentPostedMinor: 0, thresholdMinor: gbp })).toBe(true);
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: 30_000, recentPostedMinor: 0, thresholdMinor: HOME })).toBe(false);
  });

  it("a Nigerian school behaves exactly as before", () => {
    const ngn = threshold("NGN");
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: 100_000, recentPostedMinor: 0, thresholdMinor: ngn })).toBe(false);
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: HOME, recentPostedMinor: 0, thresholdMinor: ngn })).toBe(true);
  });

  it("a refund still always needs a second person, at any threshold", () => {
    // Money leaving is not judged by size, and no per-school figure may weaken
    // that — including a school that sets a very high threshold.
    expect(paymentNeedsApproval({ kind: "REFUND", amountMinor: 1, recentPostedMinor: 0, thresholdMinor: 1_000_000_000 })).toBe(true);
  });

  it("and splitting is still caught, whatever the threshold is", () => {
    // The cumulative property is independent of the figure; this pins that the
    // per-school change did not quietly re-open the evasion it closed.
    const t = 25_000;
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: 12_500, recentPostedMinor: 0, thresholdMinor: t })).toBe(false);
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: 12_500, recentPostedMinor: 12_500, thresholdMinor: t })).toBe(true);
  });
});

describe("the library fine, which fails the OTHER way", () => {
  it("keeps ₦50 a day for a school on the platform's currency", () => {
    expect(fine("NGN")).toBe(5000);
    expect(fine(null)).toBe(5000);
  });

  it("charges NOTHING in another currency until the school sets a rate", () => {
    // £50 a day for an overdue reading book, otherwise — on a real invoice, to
    // a real family.
    for (const c of ["GBP", "XOF", "GHS"]) {
      expect([c, fine(c)]).toEqual([c, 0]);
    }
  });

  it("uses the school's own rate once set", () => {
    expect(fine("GBP", 20)).toBe(20); // 20p a day
  });
});

describe("the two fail-safes point in opposite directions, on purpose", () => {
  it("an unset CONTROL tightens and an unset CHARGE goes to zero", () => {
    // Stated as one assertion because the pair is the reasoning: if both ever
    // resolve the same way, one of them is wrong.
    expect(threshold("GBP")).toBe(0); // 0 threshold = everything reviewed
    expect(fine("GBP")).toBe(0); // 0 rate = nothing charged
    // Same number, opposite meaning — which is exactly why each needs its own
    // named function rather than a shared "default for this currency" helper.
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: 1, recentPostedMinor: 0, thresholdMinor: threshold("GBP") })).toBe(true);
    expect(0 * fine("GBP")).toBe(0);
  });
});

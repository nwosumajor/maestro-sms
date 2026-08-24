// =============================================================================
// The approval threshold is CUMULATIVE
// =============================================================================
// Judged per payment it is trivially evaded. Confirmed live before the fix:
//
//   one payment of NGN 60,000    -> PENDING_APPROVAL
//   two payments of NGN 30,000   -> POSTED + POSTED
//   invoice                      -> PARTIALLY_PAID off the split
//
// Same amount, same person, same invoice: one route through the control and one
// straight past it. The control exists so a large sum moving gets a second pair
// of eyes; splitting it is the obvious way to avoid that, so the rule has to
// look at what has already moved.
// =============================================================================

import { PAYMENT_APPROVAL_THRESHOLD_MINOR, paymentNeedsApproval } from "@sms/types";

// The platform's HOME-currency default. It is passed EXPLICITLY now: the
// threshold became a per-school figure, because 5,000,000 minor units is
// ₦50,000 in a Nigerian school and £50,000 in a British one — a maker-checker
// rule that never fires. Every property below is about the CUMULATIVE rule,
// which is independent of what the threshold happens to be, so they all use the
// default. The per-school resolution has its own suite.
const T = PAYMENT_APPROVAL_THRESHOLD_MINOR; // NGN 50,000 in kobo

describe("paymentNeedsApproval", () => {
  it("a single payment over the threshold still needs approval", () => {
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: T + 1, recentPostedMinor: 0 , thresholdMinor: T })).toBe(true);
  });

  it("a small payment on a quiet invoice does not", () => {
    // The common case must stay frictionless, or the control becomes the reason
    // receipts are recorded late.
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: 100_000, recentPostedMinor: 0 , thresholdMinor: T })).toBe(false);
  });

  it("SPLITTING no longer evades it", () => {
    // The second NGN 30,000 sees the first and crosses the line.
    const half = T / 2;
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: half, recentPostedMinor: 0 , thresholdMinor: T })).toBe(false);
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: half, recentPostedMinor: half , thresholdMinor: T })).toBe(true);
  });

  it("three-way splitting is caught on the payment that crosses it", () => {
    const third = Math.ceil(T / 3);
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: third, recentPostedMinor: 0 , thresholdMinor: T })).toBe(false);
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: third, recentPostedMinor: third , thresholdMinor: T })).toBe(false);
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: third, recentPostedMinor: third * 2 , thresholdMinor: T })).toBe(true);
  });

  it("exactly the threshold needs approval", () => {
    // >= not >: the boundary belongs on the cautious side.
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: T, recentPostedMinor: 0 , thresholdMinor: T })).toBe(true);
    expect(paymentNeedsApproval({ kind: "PAYMENT", amountMinor: T - 1, recentPostedMinor: 0 , thresholdMinor: T })).toBe(false);
  });

  it("a REFUND always needs approval, however small", () => {
    // Money leaving is not judged by size.
    expect(paymentNeedsApproval({ kind: "REFUND", amountMinor: 1, recentPostedMinor: 0 , thresholdMinor: T })).toBe(true);
  });
});

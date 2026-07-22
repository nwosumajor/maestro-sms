# Payment receipts & role guides

> Universal payment receipts (every posted fee payment → payer+guardians+student email w/ balance; failure notices) + /help sections for all role families + middleware matcher holes fixed; live-verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Two builds + a found bug (user-requested):
- **Universal receipts**: `FeesService.sendPaymentReceipt` fires on EVERY posted
  payment — manual recordPayment (partial AND full, was full-only), maker-checker
  approvePayment (incl. REFUND → "Refund processed"), and the ONLINE card webhook
  (`handleInvoiceCharge` previously sent NOTHING — now receipts payer
  [metadata.payerId added at init] + guardians + student, deduped, after the
  committed write). Body carries amount/method/gateway-ref/invoice-ref + NEW
  balance ("fully paid" vs "Outstanding balance: ₦X"). notifyGuardians gained
  extraRecipientIds.
- **Failure notices**: billing mismatch path now returns {mismatch} and emails
  the initiator "Payment failed … NOT extended"; new
  `BillingService.failByReference` handles Stripe
  `checkout.session.async_payment_failed` (marks PENDING→FAILED + notifies).
  Paystack CARD DECLINES produce no webhook — parent sees the decline on the
  hosted page (industry norm; documented honestly).
- **/help role coverage**: new gated sections — Finance (fee.approve/fee.manage:
  maker-checker, auto-receipts, settlement setup, reports), HR (hr.read: leave
  chain, payroll maker-checker, exits), Approvers (workflow.review.head/hr),
  Facilities (hostel/transport/library.manage), Board (workflow.veto). Basics
  mentions forgot-password. All 17 roles now have relevant guidance.
- **BUG FOUND+FIXED**: middleware matcher was missing /help /family /gradebook
  /scholarships /content (and listed nonexistent "/grades") — those pages 500'd
  (session! non-null assertion) instead of 307→login when signed out. All added;
  every app route now 307s unauthenticated.
Verified live: partial ₦3,000 cash payment → "[email-stub] parent@ + student@
(Payment receipt — successful)" with "Outstanding balance: NGN 7000.00"; 23
api tests green (billing e2e incl. mismatch); smoke accountant/hrmanager/warden/
board + admin, 70 routes. Test invoice rows deleted. Intl split answer: Paystack
subaccounts = NGN/Paystack-market schools only; international parents CAN pay a
Nigerian school (international cards, ~3.9% fee); schools OUTSIDE Nigeria need
Stripe Connect (not built — future mirror of the subaccount model). UNCOMMITTED.

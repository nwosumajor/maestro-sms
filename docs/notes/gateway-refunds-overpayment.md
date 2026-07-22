# Gateway refunds & overpayment

> Approved CARD refunds auto-push to Paystack's refund API (back to the original card, best-effort w/ explicit manual-fallback notice) + webhook overpayment alerts to finance; live-verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Refund automation + overpayment detection (user-requested):
- **`PaystackService.refund`** (POST /refund {transaction, amount}): keyed on the
  ORIGINAL transaction reference so money can only return to the paying card
  (never redirectable); returns {ok:false} instead of throwing (caller falls
  back to manual). Paystack also enforces the refundable remainder server-side.
- **`FeesService.approvePayment`**: for an approved REFUND, the tx finds the
  most recent POSTED CARD payment on the invoice with amount ≥ refund
  (gatewayRef); AFTER the committed ledger decision, if gateway configured the
  refund is pushed — success audited `fee.refund.gateway`, failure audited
  `.failed` + the APPROVER is emailed "return the funds manually". The
  parent/student refund notice appends: "being returned to the original card" |
  "school will return the funds to you directly" (cash / unset gateway) |
  "automatic card refund FAILED — manual". Ledger decision stands either way
  (business record). Design choice: no PROCESSING claim state — the single
  PENDING_APPROVAL→POSTED tx claim prevents double gateway pushes.
- **Overpayment detection**: `handleInvoiceCharge` — when a webhook credit
  pushes paid > total (two guardians racing), finance (accountant +
  school_admin roles + invoice creator) get "Overpayment … refund due" (in-app
  + email). FeesService spec updated: partial payments now EXPECT a receipt
  (old test asserted none); pendingPayment mock needs method/reference.
  FeesService constructor gained PaystackService (4 args — update mocks).
- Verified live: refund PENDING_APPROVAL → self-approve 403 → principal approve
  201 → "Refund processed" to parent+student w/ balance + manual-return note;
  over-refund 400; 17 fees/payments tests green (3 refund-payload unit tests in
  paystack.service.spec); smoke accountant+principal 70 routes. Approve route is
  POST /payments/:id/approve (not /fees/payments/...). Test rows deleted.
  Live gateway push needs PAYSTACK_SECRET_KEY. Subscription refunds remain
  operator comp/extend by design (cash-back via gateway dashboards). UNCOMMITTED.

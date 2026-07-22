# Dual-currency billing

> NGN (Paystack) + USD (Stripe) platform billing; ENTERPRISE is USD-only everywhere (homepage, quotes, checkout, operator pricing); live-verified 2026-07-13 minus real gateway creds, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Dual-currency platform subscription billing (user-requested, world + Nigeria):
- **Model** (`@sms/types/modules.ts`): `CURRENCIES` NGN|USD, `CURRENCY_SYMBOL`,
  `planCurrencies(plan)` (ENTERPRISE → [USD]; others → [NGN, USD]),
  `defaultCurrencyFor` (₦; $ for ENTERPRISE), `PLAN_PRICING_USD` (cents:
  25/40/60/100) + `PLAN_PRICING_BY_CURRENCY`. The NGN table keeps an ENTERPRISE
  entry only for Record totality — planCurrencies gates every surface.
- **DB** (migration `20260713020000_multi_currency_billing`): `plan_price` PK →
  (plan, currency); `platform_subscription_payment.currency` (default NGN);
  `school_subscription.currency` (nullable, set on payment).
- **StripeService** (`payments/stripe.service.ts`): fetch-only (no SDK, mirrors
  Paystack), Checkout Sessions (form-encoded, metadata.kind=subscription,
  client_reference_id=our reference), webhook verify = HMAC-SHA256 over
  `t.rawBody` with STRIPE_WEBHOOK_SECRET + 5-min replay tolerance. Envs:
  STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / PUBLIC_WEB_URL (success_url) —
  unset ⇒ clean 503 / no-op webhook. Webhook route: @Public POST
  /billing/stripe/webhook (Stripe is billing-only, unlike the account-wide
  Paystack webhook on the fees route). Nest rawBody:true already global.
- **Billing**: quotes = tier × cycle × ALLOWED currency (21 rows);
  `initCheckout` takes currency (default = tier default), routes NGN→Paystack /
  USD→Stripe, 400s ENTERPRISE+NGN; both webhooks share idempotent
  `applyPaidByReference`. PlanPricingService is per-(plan,currency) with the
  same 60s cache + Redis fan-out; update() refuses ENTERPRISE NGN rows.
- **Web**: homepage cards ₦ for three tiers + $ for ENTERPRISE (tier's
  defaultCurrencyFor row); footnote explains gateways; OnboardForm estimate
  follows the tier's currency; BillingCheckout gained a currency select (locks
  to USD for ENTERPRISE) + "Pay with Paystack/Stripe" + currency-aware totals;
  payment history/last-charged use money(minor, currency); operator
  PricingManager has Naira (Paystack) + US Dollar (Stripe) sections (7 rows).
- **Settlement cross-check (same day)**: `applyPaidByReference` now takes the
  GATEWAY-reported `{amountMinor, currency}` (Paystack `data.amount`/`currency`,
  Stripe `amount_total`/`currency`) and refuses to activate when reported <
  expected or currency ≠ payment.currency — payment flips FAILED +
  `billing.subscription.payment.mismatch` audit; webhook still 200s (no
  infinite gateway retries). Covered by 2 e2e mismatch cases (billing e2e now
  4 tests — run with DATABASE_URL **and** TEST_DATABASE_URL/TEST_ADMIN_URL set).
- **Cycle discounts (same day)**: CYCLE_MONTHS is now MONTH 1 / TERM 3 / YEAR 9
  (3 terms, holidays unbilled — was 4/12). `CYCLE_DISCOUNT_PERCENT`
  {MONTH 0, TERM 5, YEAR 15} + pure `applyCycleDiscountMinor` (Math.round once)
  + `computeSubscriptionGrossMinor`; `computeSubscriptionPriceMinor` returns the
  DISCOUNTED net and prices every surface (quotes/checkout/webhook cross-check/
  homepage/onboard estimate). Renewal extension uses the same CYCLE_MONTHS.
  Homepage cards show ₦/term (save 5%) · ₦/year (save 15%) per tier ($ for
  ENTERPRISE) + `fmtAmount` (whole stays whole, else 2dp); BillingCheckout cycle
  labels + a "save ₦X" badge (gross derived from the undiscounted MONTH quote);
  OnboardForm gained a billing-cycle select with discounted estimate. e2e spec
  now derives amounts from computeSubscriptionPriceMinor (no hardcoded 4-month
  math). Live-verified: term = round(month×3×.95), year = round(month×9×.85)
  exact in NGN + USD; homepage lines render; smoke green.
- Verified live: 7 public rows, ENTERPRISE USD-only; operator PUT NGN-for-
  ENTERPRISE → 400; USD override propagates to public instantly; checkout 400/
  503 paths per gateway; disabled-webhook benign; 17 unit tests (currency rules
  + Stripe signature incl. tamper/stale/replay); homepage ₦500/750/1000 + $1;
  route smoke owner+principal green. REAL charging untested (no creds; needs
  STRIPE_* + PAYSTACK_SECRET_KEY + outbound net). UNCOMMITTED.

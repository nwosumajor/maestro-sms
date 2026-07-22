# Referral program

> School-refers-school growth loop on the billing engine — both sides earn one free term on the referred school's first paid subscription (2026-07-16)

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Built the referral program end-to-end (user's revenue/onboarding growth ask):
code panel on `/billing` (`GET /billing/referral`, `POST /billing/referral/code`,
reuses billing.read/manage — no new perms), public `/onboard?ref=CODE` prefill +
form field, privileged provisioning resolves the code onto
`SchoolSubscription.referredBySchoolId`, and the payment webhook
(`applyPaidByReference`, both Paystack + Stripe) grants BOTH sides
`REFERRAL_REWARD_MONTHS` (= CYCLE_MONTHS.TERM = 3 months, in `@sms/types`) on the
FIRST paid subscription.

Key mechanics worth remembering:
- **Atomic cross-tenant grant**: `ReferralService.grantRewardsInTx` switches the
  tx-local RLS GUC (`set_config('app.current_school_id', …, true)`) to the
  referrer and back inside the SAME payment transaction — chosen over a second
  runAsTenant because a crash between two txs would silently lose the referrer's
  reward (webhook retry sees payment PAID → never re-grants).
- **Double idempotency**: optimistic `updateMany(referralRewardAt IS NULL)` claim
  + DB-unique `school_referral_conversion.referredSchoolId`.
- Tables owned by the REFERRER school; conversion ledger APPEND-ONLY (no
  UPDATE/DELETE grants). RLS file 70, migration `20260828000000_referral`,
  entrypoint sentinel `school_referral_conversion_insert`, RLS e2e cases added
  (coverage gate green).
- Verified: API 482 unit tests + referral genReferralCode spec + a DB-gated
  billing e2e case (reward once, second payment no double-grant); web build 76
  routes. **Why:** money logic — always test idempotency against retries.
- Same session also shipped: chess threefold-repetition (engine + `repetition`
  JSONB column), ring timeout auto-nudge (client calls existing POST
  /rings/:id/timeout), typing anti-paste ceiling (20 chars/sec server law), quiz
  self-rank in DTO, and the games design pass (arcade hub tiles, Kahoot quiz
  tiles, bigger boards, confetti win moments). ALL COMMITTED + PUSHED to main
  (merge c46afdd, 5 commits on feat/games-polish-and-referral) and LIVE on the
  local Docker stack.
- **Homepage marketing** (same session): `#referral` "Give a term, get a term"
  band after Plans (receipt-style both-sides visual, CTAs split existing-school→
  /login vs referred→/onboard), pricing-section chip, FAQ entry, footer link —
  copy matches implementation exactly (3 months, first paid sub, no cap).
- **Theme-toggle fix** (same session): 8 public pages (onboard/apply/careers(+slug)/
  schools/reset-password/enroll/welcome) had hardcoded `force-light` ignoring the
  global ThemeScript/ThemeToggle — removed + floating toggle added (login-style).
  All verified live via curl.
Related: [dual-currency-billing](dual-currency-billing.md), [onboarding-flow-upgrade](onboarding-flow-upgrade.md), [module-entitlements](module-entitlements.md), [dark-console-theme](dark-console-theme.md).

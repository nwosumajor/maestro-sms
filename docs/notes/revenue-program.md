# Revenue program

> Eight-feature monetization program (take-rate, admission fees, auto-renew, proration/true-up, promos/agents, message credits, group console, CBT) built 2026-07-16/17

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Built the full 8-item revenue program the user picked (skipping AI add-on/BNPL/
wallets): two commits on feat/revenue-program merged to main (ac2f687) and
pushed. Details live in CLAUDE.md §"Revenue program (July 2026)". Key patterns
worth reusing:
- **Global config tables** follow plan_price (rls SELECT-only, privileged
  writes): platform_fee_config, promo_code, agent. **Deny-all globals** (no
  policy, no grant) for platform money/authz: agent_commission, school_group*.
- **Webhook dispatch by metadata.kind** now covers: invoice (default),
  subscription, admission_form, credits — all through
  PaymentGatewayService.handleWebhook; every apply idempotent on the gateway
  reference; fee/credit AMOUNTS re-validated server-side against config, never
  trusted from metadata.
- **Parent-borne fees**: the charge exceeds the invoice — the webhook must
  credit metadata.invoiceAmountMinor, NOT event.amount (fee recorded on
  payment.platformFeeMinor).
- **payment.kind drives apply semantics** (RENEWAL stack / UPGRADE restart /
  TRUEUP seats-only, priceMinor untouched so future proration stays correct).
- IDE TS server was persistently stale on regenerated Prisma types all session —
  ONLY trust `pnpm --filter X exec tsc --noEmit`.
- Pure money fns + tests in @sms/types: computePlatformFeeMinor,
  prorationCreditMinor, computeTrueUpMinor, MIN_CHARGE_MINOR,
  MESSAGE_CREDIT_BUNDLES, REFERRAL_REWARD_MONTHS.
- GROUP + CBT started as pure add-ons; user then bundled BOTH into ENTERPRISE
  (a5b98c8) — Enterprise = all 27 modules; other tiers buy them via overrides.
- **Seat arrears metering** (04e209d): daily sweep accrues seat-days above the
  billed count (`accrueSeatArrearsMinor`, `seatArrearsMinor`/`arrearsAccruedAt`
  on the sub, `arrearsMinor` snapshot on each payment); collected via top-up OR
  auto-added to renewal/upgrade/auto-renew charges; settle decrements by the
  payment snapshot, never blind-zeroes. Closes the "ignore the true-up and ride
  extra seats free" leak — delay no longer discounts.
- Seed gained cbt.manage (staff x3) + cbt.take (student) — deployed DBs re-seed
  via SEED_ON_START (idempotent).
- **Legal pack + clickwrap** (0d3578a docs, fb0cc92 impl): docs/LEGAL.md (5 drafts,
  counsel review + NDPC registration pending, `[●]` placeholders); /legal/[slug]
  static pages from content/legal.ts (AUTO-DERIVED from docs/LEGAL.md — regen on
  change); LEGAL_DOCS_VERSION in @sms/types drives everything: onboarding
  checkbox (zod literal(true) → onboarding_request.legalVersion), append-only
  legal_acceptance ledger (rls/76) + AppShell banner for billing.manage when the
  school lacks the current version, and checkout audits stamp the version.
  Bumping the version re-raises the banner fleet-wide.
- **Rollout pack + homepage accuracy** (59c898f): docs/LEGAL_ROLLOUT.md is the
  non-engineering programme (decision sheet for all 31 [●]s with recommended
  defaults, counsel brief, NDPC/DPO/DPIA/insurance, launch checklist) — hand it
  to counsel with docs/LEGAL.md. Homepage module count now DERIVES from
  MODULE_CATALOG.length (hero CTA + StatBand) so it can't go stale again;
  register grid gained CBT + Group Console cards (27). Pending small eng task
  the pack references: publish /legal/subprocessors before the effective date.
Related: [referral-program](referral-program.md), [dual-currency-billing](dual-currency-billing.md), [module-entitlements](module-entitlements.md),
[settlement-and-login-showcase](settlement-and-login-showcase.md).

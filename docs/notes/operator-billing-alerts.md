# Operator billing alerts

> super_admin red alerts for lapsed schools: dunning sweep OPERATOR_ALERT digest (in-app red + email) + GET /operator/billing-alerts + red console banner + SubscriptionManager status/period restore controls; live-verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Operator visibility+control for lapsed subscriptions (user-requested):
- **Sweep alert**: `BillingDunningService.sweep` ends with `alertPlatformOwners`
  — ONE aggregated OPERATOR_ALERT per super_admin (in-app + EMAIL channel)
  listing EVERY currently-PAST_DUE school sorted most-overdue first: "Name
  (PLAN) — N days past due, DOWNGRADED to Standard | X grace day(s) left"
  (capped at 12 + "and N more"). Runs daily via the scheduled sweep + manual
  POST /billing/dunning/run. DunningResult gained `alerted`. Best-effort.
- **`GET /operator/billing-alerts`** (platform.operate; privileged client, [] w/o
  URL) → `OperatorBillingAlertDto[]` {schoolId,name,slug,plan,currentPeriodEnd,
  daysPastDue,downgraded}; feeds a RED banner card at the top of /operator with
  per-school badges + link to the PAST_DUE-filtered list.
- **Restore/comp/extend controls**: `SubscriptionManager` now loads + submits `status`
  (ACTIVE/PAST_DUE/CANCELED select) and `currentPeriodEnd` (date input → end-of-
  day UTC ISO; empty ⇒ null/clear) alongside plan+overrides — the operator PUT
  already accepted them, the UI just never exposed it.
- **Inbox red styling**: `NotificationInbox` renders OPERATOR_ALERT with a
  destructive card frame/dot/title (ALERT_TYPES set) + whitespace-pre-line body
  so the school list reads line-per-school.
- Verified live: seeded elapsed school → manual dunning {pastDue:1, alerted:1} →
  owner inbox alert "10 days past due, DOWNGRADED" + [email-stub] send →
  billing-alerts returns banner data → operator PUT (ACTIVE + future date)
  clears it to 0. billing e2e 4/4 still green; owner route smoke green.
  Test school deleted. UNCOMMITTED.

# Onboarding auto-credentials

> Approve & provision now auto-generates school_admin + principal sign-in accounts (admin@<slug>.school / principal@<slug>.school); requester emailed sign-in emails + set-password LINKS (never passwords); console shows temp passwords once w/ 10-min auto-hide; live-verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Builds on [onboarding-flow-upgrade](onboarding-flow-upgrade.md) + [invite-links-and-help](invite-links-and-help.md). User asked for
one-click Approve → auto-generated founding credentials; clarified: email the
LOGIN EMAILS + links to the requester, but NEVER the password.

- Web `Provisioning.tsx`: on `?provision=<id>` prefill, BOTH founding accounts
  auto-fill — school_admin (contact name, `admin@<slug>.school`) + principal
  ("Principal", `principal@<slug>.school`); generated emails TRACK the slug
  until the operator edits them (touched flags). Contact email stays on the
  request for correspondence only.
- API `provisionSchool`: when `onboardingRequestId` present, the requester's
  "now live" email lists each account's role + sign-in email + a ONE-TIME
  7-day `/welcome?token=` set-password link (mintInviteToken per admin).
  Passwords never emailed. Per-account invite emails are SKIPPED on the
  request path (generated addresses have no inbox — avoids provider bounces);
  the manual add-admin path still sends them. Welcome notification wording
  adapts ("sent to your onboarding contact").
- Console credentials panel now AUTO-HIDES after 10 min (visible m:ss
  countdown) besides manual dismiss; temp passwords remain the shown-once
  fallback (forced first-login reset via passwordChangedAt=null unchanged).
- GOTCHA: route-smoke `SMOKE_ROLES` takes FULL emails
  ("owner@sms.platform"), not shorthand — "owner,admin" logs in with literal
  "owner" → API 400 (zod email), looks like rate-limit skips.
Verified live: request→provision e2e (creds returned once, request APPROVED,
stub email to requester, no password in any log), test tenant cleaned
(audit_log rows too — school FK), owner+admin × 70 routes green. UNCOMMITTED.

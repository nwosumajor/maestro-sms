# Email delivery

> Real outbound email: EmailService (Resend/Postmark via fetch, env-gated) + EMAIL channel routing + receipts/dunning/welcome/owner-alert tagged + direct onboarding requester emails (ack/live/rejected); stub-verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Email delivery built on the existing notification pipeline (user-requested):
- **`EmailService`** (`apps/api/src/notifications/email.service.ts`): the ONE
  outbound transport — fetch-only (no SDK), `EMAIL_PROVIDER` resend (default) |
  postmark, `EMAIL_API_KEY` (unset ⇒ log-stub "[email-stub] -> to (subject)",
  ok:true so the pipeline stays exercisable), `EMAIL_FROM`. Never throws; never
  logs bodies (PII). Documented in apps/api/.env.example.
- **`EmailChannelProvider`** chains over the inner provider (Twilio-SMS or
  logging): EMAIL → EmailService, SMS/PUSH → inner. Bound via useFactory in
  NotificationModule (which now also exports EmailService for direct sends).
- **Events now tagged `channels:["EMAIL"]`**: billing payment receipt
  ("Subscription active … your payment receipt"), dunning renewal/past-due
  notices, provisioning welcome (says temp password is NEVER emailed), owner
  new-onboarding-request alert. (Attendance/fees/documents/transport/alumni were
  already tagged.)
- **Direct requester emails** (no account yet): ack on public submit
  (PublicService), "school is live" on provision-from-request + courteous
  rejection on first REJECTED transition (OperatorProvisioningService — fetches
  contact from the request row; rejection guarded by prior-status check so
  re-saves don't re-send). All best-effort.
- Verified: 5 unit tests (payload per provider, disabled no-op, failure
  semantics, channel routing); live stub run — submit → "[email-stub] ->
  requester (ack)" + owner alert delivered through BullMQ with
  notification_delivery row EMAIL|SENT; reject → courteous email. Real sending
  needs EMAIL_API_KEY (+ domain-verified EMAIL_FROM). UNCOMMITTED.

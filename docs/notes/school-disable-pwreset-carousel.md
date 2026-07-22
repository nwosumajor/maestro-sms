# School disable, pw-reset, login carousel

> School DISABLE now blocks all member logins (new operator lever + toggle UI), public forgot-password reset flow (30m single-use pca-bound tokens), login page image carousel; live-verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Three builds (user-requested):
- **School disable = hard login block**: AuthService.login returns
  SCHOOL_SUSPENDED (401) when school.status !== ACTIVE — checked AFTER password
  verification (no oracle); super_admin exempt. NEW endpoint (none existed —
  school.status previously only filtered the public directory):
  `PUT /operator/tenants/:schoolId/status` {ACTIVE|DISABLED} (platform.operate +
  step-up; PRIVILEGED client — app role is SELECT-only on school; audited) +
  `SchoolStatusToggle` on each tenant card (confirm dialog). Nothing deleted;
  re-enable restores instantly. NOTE: existing JWT sessions survive until expiry
  (login-time check only). Payment-while-blocked answer: PAST_DUE never disables
  (self-serve /billing stays open); manual DISABLE ⇒ restore path is operator-
  side (offline payment → re-enable + comp/extend), which is the intent.
- **Forgot password**: `mintPasswordResetToken` purpose "pwreset", 30m TTL,
  `pca` claim = passwordChangedAt epoch (0 for null) ⇒ single-use (any reset/
  change kills all outstanding links). `POST /public/password-reset/request`
  {email} — always {ok:true} (no oracle), reuses app_login_lookup, emails link
  to `/reset-password?token=`; `/confirm` {token,password}. Locked accounts stay
  locked (reset ≠ reactivation). Web: /reset-password page (2-mode
  ResetPasswordFlow) + "Forgot your password?" link on LoginForm. GOTCHA when
  testing with raw pg: naive timestamps parse as LOCAL in pg vs UTC in Prisma —
  mint test pca via `extract(epoch from (col AT TIME ZONE 'UTC'))*1000`.
- **Login carousel**: login aside now layers HeroCarousel (hero-1..4 +
  band-community, 6s, no dots) under a dark gradient scrim; branding/copy on top.
Verified live: disable→member 401 SCHOOL_SUSPENDED / owner exempt / re-enable
restores; reset request (unknown email same 201) → email-stub → confirm 201 →
login with new password → replay 400; demo teacher password restored; login
page shows carousel + forgot link; smoke 70×2 green. Test school deleted.
UNCOMMITTED.

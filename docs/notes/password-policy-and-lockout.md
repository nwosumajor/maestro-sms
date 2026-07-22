# Password policy & lockout

> 30-day forced password reset + 3-strike permanent lockout (super_admin reactivates)

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**Auth hardening (2026-07-01).** Two policies in `apps/api/src/foundation/auth.service.ts`:

1. **30-day forced password reset** — every account EXCEPT super_admin must reset within
   `PASSWORD_MAX_AGE_DAYS=30`. Pure helper `isPasswordExpired(passwordChangedAt, isSuperAdmin)`
   (exported; unit-tested in `test/foundation/password-policy.spec.ts`). On successful login,
   roles are resolved and `passwordExpired` is computed (super_admin exempt) and returned in
   `LoginResult`. Threaded web-side: `LoginResult` → next-auth `authorize`/`jwt`/`session`
   (`apps/web/lib/auth.ts`, `types/next-auth.d.ts`) → `middleware.ts` redirects an expired user
   to `/account/password` (checked BEFORE the MFA mandate). New standalone page
   `app/(app)/account/password/page.tsx` + `components/auth/ChangePasswordForm.tsx` POST to the
   authed `POST /auth/change-password` (verifies current pw, rejects reuse, ≥8 chars, stamps
   `passwordChangedAt=now()`), then `signOut` → re-login with the fresh session.

2. **3-strike PERMANENT lockout** — `MAX_FAILS=3` (was 5); the 15-min auto-expiry is GONE. On the
   3rd miss the login sets `user.locked=true` (+`lockedUntil=now()` as a record). A locked account
   returns `ACCOUNT_LOCKED` even with the correct password. ONLY a super_admin reactivates it via
   the operator console `POST /operator/tenants/:schoolId/users/:userId/unlock` (`platform.operate`;
   clears `locked/failedLoginCount/lockedUntil`). No school-level unlock exists.

**Schema (migration `20260724000000_password_policy`):** `user.locked BOOLEAN DEFAULT false` +
`user.passwordChangedAt TIMESTAMP DEFAULT now()` (the DEFAULT backfills existing rows to a fresh
window; a null value = must-change-immediately). Operator `resetPassword` sets
`passwordChangedAt=null` so an admin-issued temp password forces a change on first login.
`OperatorUserDto` gained `locked`; `OperatorUsers.tsx` shows a "locked" badge + a "Reactivate (unlock)"
button only when locked. Verified live: 3-wrong→locked→correct-pw-still-blocked; super_admin unlock→login OK;
school_admin unlock→403; 31-day-old pw→passwordExpired for teacher, false for owner; change-password clears it.

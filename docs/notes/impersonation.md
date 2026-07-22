# Impersonation

> Impersonation: why it had no web UI (architectural), the audit-attribution hole found + fixed (8934101), and the session bridge + UI built (8d00ea0). 2026-07-15.

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**Purpose**: support. Access is decided by JWT→guard→RLS + relationship scoping + module
entitlements, so a bug can be specific to ONE user in ONE school and invisible from the
owner's account. Impersonation is the only practical way to see what they see. It IS total
control → super_admin only, step-up gated, audited, NON-elevatable ([platform-permission-split](platform-permission-split.md)).

**Why there was no web UI (architectural, NOT an oversight):** the web auth model is "the
browser never holds a verifiable API token" — Auth.js owns the session cookie, and
`lib/apiToken.ts:bearerForSession()` mints a 5-min API token SERVER-side from session claims.
`POST /operator/impersonate` returns a raw API bearer, which the browser has nowhere to put,
and the only session-minting path was the email+password Credentials provider. API half
shipped; session bridge never did.

**HOLE FOUND + FIXED (merged 8934101)** — impersonation was auditable only at the MOMENT it
started. `verifyToken` DROPPED the `imp` claim, so from the next request on every audited
action recorded `actorId = target` with nothing tying it to the operator ("the parent
downloaded this", not "the owner did, as the parent"). Fix chain:
`jwt.ts` parses `imp.by` → `Principal.impersonatedBy` → `PermissionGuard` (the ONLY place the
token is verified) writes it into an **AsyncLocalStorage** store opened by
`RequestContextMiddleware` (middleware because it wraps next(), so the store propagates) →
`AuditLogService.record` stamps `metadata.impersonatedBy` on EVERY entry automatically.
Deliberately NOT a parameter: ~hundreds of audit call sites would each have to remember it.
`actorId` stays the TARGET (they really are the principal).

**UI built (merged 8d00ea0):**
- API impersonation token now also carries `name`/`schoolName`/`modules` (target school's
  effective modules) INSIDE the signed token — not the response body — so the browser can't
  hand itself another school/module set. Without modules the module-gated nav renders empty.
- `lib/auth.ts`: an `impersonate` Auth.js Credentials provider — the ONLY session not from
  email+password. Verifies HS256 sig AND **requires `imp.by`**, so an ordinary 5-min service
  token can't be used (else any leaked token = a session-minting oracle).
- `session.user.impersonatedBy` → propagated back into `bearerForSession()` as `imp.by`, or
  the UI silently re-opens the audit hole.
- `ImpersonateButton` ("Sign in as", gated `platform.impersonate`, confirm-first, reuses
  `postWithStepUp`); `ImpersonationBanner` read from the SESSION in AppShell (not a prop) so
  no caller can render an impersonated shell without it.
- **Exit = sign out + log back in** (deliberate). One-click "return to owner" would require
  stashing the owner's claims inside the impersonated session — not worth it.

**Live proof**: two identical `hr.employee.list` rows, same actor, now distinguishable —
one `(none)` and one stamped with the owner's userId. Previously identical. Suite 651/651.

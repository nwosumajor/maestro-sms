// =============================================================================
// Auth.js (NextAuth v5) — owns login + session, issues the JWT (CLAUDE.md).
// =============================================================================
// The Credentials provider verifies the password against the REAL user store via
// the stateless API `POST /auth/login` (bcrypt + DB lookup there). The API
// returns the user's tenant + RBAC claims, which we stamp onto the signed JWT;
// the API then verifies that JWT on every request.
// =============================================================================

import NextAuth from "next-auth";
import { forwardedFor } from "./forwarded";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import jwt from "jsonwebtoken";
import { PLATFORM_REGION } from "@/lib/format";
import { sessionPermissions } from "./permissions";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

// --- Dual-secret rotation window ---------------------------------------------
// AUTH_SECRET signs everything new; AUTH_SECRET_PREVIOUS (when set, during a
// rotation) is accepted for VERIFICATION only. Passed as an array to Auth.js —
// @auth/core encrypts new session cookies with secrets[0] and tries the whole
// array on decrypt — so rotating no longer force-logs-out the entire fleet.
const AUTH_SECRETS = [process.env.AUTH_SECRET, process.env.AUTH_SECRET_PREVIOUS].filter(
  (s): s is string => typeof s === "string" && s.length > 0,
);

// --- Mid-session claim revalidation -------------------------------------------
// Claims (roles/permissions/modules) otherwise live as long as the session's
// 30-day sliding window — a revoked role or disabled account wouldn't bite until
// re-login. The jwt callback below re-pulls claims from GET /auth/refresh every
// CLAIMS_REFRESH_MS of activity: explicit 401/403 ⇒ the session is killed
// (revocation lands within minutes); network/5xx ⇒ keep existing claims and
// retry after CLAIMS_RETRY_MS (an API blip can never log users out).
const CLAIMS_REFRESH_MS = Number(process.env.SESSION_CLAIMS_REFRESH_SEC ?? 600) * 1000;
const CLAIMS_RETRY_MS = 60_000;

interface RefreshedClaims {
  schoolName: string;
  roles: string[];
  permissions: string[];
  modules: string[];
  timezone: string;
  locale: string;
  currency: string;
  mfaEnrollRequired: boolean;
  passwordExpired: boolean;
  passwordChangedAtMs: number;
  /** Permissions held by an ACTIVE elevation grant rather than by a role. */
  elevated?: string[];
}

/** The claims the refresh bearer is minted from — everything that can change the
 *  ANSWER. Two `auth()` calls carrying identical values must get identical
 *  claims, which is what makes the per-request memo below sound. */
interface RefreshInput {
  userId: string;
  schoolId: string;
  roles: string[];
  pwdAt?: number;
  impersonatedBy?: string;
}

// --- The burst memo ----------------------------------------------------------
// ONE revalidation per render, however many times `auth()` is called.
//
// // GOTCHA: the throttle above (`claimsAt` / `claimsTriedAt`) stamps the TOKEN,
// and a server-component render CANNOT persist the session cookie — Next.js only
// writes it back from a route handler, server action or middleware. So inside a
// render every `auth()` call read the same stale stamp, decided a refresh was
// due, and made its own round trip. `lib/apiToken.ts` calls `auth()`, so that
// was once per server-side API call: one pupil record issued TEN
// `GET /auth/refresh` calls in a single load — three DB queries each, more
// traffic than the page's own six reads — against an interval that asks for one
// every ten minutes.
//
// Keyed on the CLAIMS, not the token object, which is deserialised afresh per
// call and would never hit a reference-keyed memo. The in-flight PROMISE is what
// is stored, so the five parallel `apiGet`s of a `Promise.all` share one round
// trip rather than each starting their own before any has finished.
//
// // GOTCHA: React's `cache()` — the obvious per-request answer — is not
// available here. React exports it only under the `react-server` condition, and
// this module is also bundled for the middleware and the Auth.js route handler;
// there it resolves to undefined and every render 500s with "cache is not a
// function". A plain TTL map is runtime-agnostic, which this file has to be.
//
// The TTL costs at most BURST_MS of extra revocation latency on a 600s interval.
const BURST_MS = 3_000;
const burst = new Map<string, { at: number; p: Promise<RefreshedClaims | "revoked" | null> }>();

/** Drop expired entries so a long-lived server doesn't accumulate one per
 *  session that ever signed in. O(size), and size is the users active within
 *  the last few seconds. */
function sweepBurst(now: number) {
  for (const [k, v] of burst) if (now - v.at >= BURST_MS) burst.delete(k);
}

const refreshClaimsOnce = (key: string): Promise<RefreshedClaims | "revoked" | null> => {
  const now = Date.now();
  const hit = burst.get(key);
  if (hit && now - hit.at < BURST_MS) return hit.p;
  sweepBurst(now);
  const p = doRefresh(key);
  burst.set(key, { at: now, p });
  // A rejected promise must not be served to the next caller for BURST_MS.
  // (doRefresh never rejects — it returns null on failure — but the memo must
  //  not be the reason that stays true.)
  void p.catch(() => burst.delete(key));
  return p;
};

const doRefresh = async (key: string): Promise<RefreshedClaims | "revoked" | null> => {
    const input = JSON.parse(key) as RefreshInput;
    const secret = process.env.AUTH_SECRET;
    if (!secret) return null;
    const bearer = jwt.sign(
      {
        userId: input.userId,
        school_id: input.schoolId,
        // Roles only — the API guard expands roles → permissions server-side.
        roles: input.roles,
        // The password this session was issued under. The API revokes a session
        // older than the stored password, which is what makes changing a
        // password actually eject whoever else was signed in as you.
        ...(typeof input.pwdAt === "number" ? { pwd_at: input.pwdAt } : {}),
        ...(input.impersonatedBy ? { imp: { by: input.impersonatedBy } } : {}),
      },
      secret,
      { algorithm: "HS256", expiresIn: "5m" },
    );
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        headers: { Authorization: `Bearer ${bearer}` },
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) return "revoked";
      if (!res.ok) return null;
      return (await res.json()) as RefreshedClaims;
    } catch {
      return null; // network blip — fail open on availability
    }
};

/** Re-fetch the caller's claims. "revoked" ⇒ kill the session; null ⇒ transient
 *  failure, keep what we have. The bearer is minted from the token's own claims
 *  (same shape apiToken.ts mints from the session — auth() is unavailable here). */
async function fetchRefreshedClaims(token: JWT): Promise<RefreshedClaims | "revoked" | null> {
  if (!process.env.AUTH_SECRET || !token.userId || !token.schoolId) return null;
  const input: RefreshInput = {
    userId: token.userId as string,
    schoolId: token.schoolId as string,
    roles: (token.roles as string[]) ?? [],
    ...(typeof token.passwordChangedAtMs === "number" ? { pwdAt: token.passwordChangedAtMs } : {}),
    ...(token.impersonatedBy ? { impersonatedBy: token.impersonatedBy as string } : {}),
  };
  return refreshClaimsOnce(JSON.stringify(input));
}

/** Claims the API stamps into an impersonation token (POST /operator/impersonate). */
interface ImpersonationClaims {
  userId: string;
  school_id: string;
  name?: string;
  schoolName?: string;
  timezone?: string;
  locale?: string;
  currency?: string;
  roles?: string[];
  permissions?: string[];
  modules?: string[];
  imp?: { by?: string };
}

interface LoginResult {
  userId: string;
  schoolId: string;
  schoolName: string;
  name: string;
  roles: string[];
  permissions: string[];
  /** Held by an ACTIVE elevation grant, not by a role. Optional so a web build
   *  running against an older API still signs people in. */
  elevated?: string[];
  modules: string[];
  /** The school's region — see the session augmentation. Optional so a web build
   *  running against an older API still signs people in. */
  timezone?: string;
  locale?: string;
  currency?: string;
  mfaEnrollRequired?: boolean;
  passwordExpired?: boolean;
  passwordChangedAtMs?: number;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Self-hosted: trust the deployment host (NextAuth refuses otherwise -> 500).
  trustHost: true,
  // Rotation window (see AUTH_SECRETS above); [AUTH_SECRET] alone when no
  // rotation is in progress — identical behaviour to the plain-string default.
  ...(AUTH_SECRETS.length > 0 ? { secret: AUTH_SECRETS } : {}),
  // Idle timeout: the session cookie lives 11 minutes and ROLLS on server
  // contact (updateAge 60s re-issues the JWT on any session read — every
  // middleware-guarded navigation, plus the SessionIdleGuard's keep-alive
  // pings while the user is active). The CLIENT warns at 9 min idle and signs
  // out at 10; the 11-min server window is the backstop that outlives the
  // 60-second warning countdown, so "Continue" still has a live session to
  // extend, while an abandoned tab's cookie dies server-side soon after.
  session: { strategy: "jwt", maxAge: 11 * 60, updateAge: 60 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email" },
        password: { label: "Password" },
        code: { label: "2FA code" },
      },
      authorize: async (creds, request) => {
        const email = String(creds?.email ?? "");
        const password = String(creds?.password ?? "");
        const mfaCode = creds?.code ? String(creds.code) : undefined;
        if (!email || !password) return null;
        const res = await fetch(`${API_BASE}/auth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // WHO IS TRYING TO SIGN IN. Without this the API sees only the web
            // task and rate-limits every school on earth against ONE bucket:
            // ten sign-in attempts a minute platform-wide, and the eleventh
            // person to try anywhere is turned away. It also means the per-IP
            // brute-force backstop protected nobody in particular.
            ...forwardedFor(request),
          },
          body: JSON.stringify({ email, password, mfaCode }),
          cache: "no-store",
        });
        if (!res.ok) return null; // invalid credentials -> failed sign-in
        const u = (await res.json()) as LoginResult;
        return {
          id: u.userId,
          name: u.name,
          email,
          schoolId: u.schoolId,
          schoolName: u.schoolName,
          timezone: u.timezone,
          locale: u.locale,
          currency: u.currency,
          roles: u.roles,
          permissions: u.permissions,
          elevated: u.elevated ?? [],
          modules: u.modules ?? [],
          mfaEnrollRequired: u.mfaEnrollRequired ?? false,
          passwordExpired: u.passwordExpired ?? false,
          passwordChangedAtMs: u.passwordChangedAtMs ?? 0,
        };
      },
    }),
    // -----------------------------------------------------------------------
    // Impersonation: the ONLY session not minted from email+password.
    // -----------------------------------------------------------------------
    // The API's step-up-gated, audited, super_admin-only POST /operator/impersonate
    // mints a short-lived HS256 token for the target. Possessing a VALID one IS the
    // authorization — it can be obtained no other way — so this provider's job is
    // simply to prove the token is genuine and turn it into a session:
    //   * verify the signature with AUTH_SECRET (pinned HS256), and
    //   * REQUIRE `imp.by` — i.e. it must be an impersonation token specifically,
    //     never an ordinary 5-minute service token, which would otherwise be a
    //     free session-minting oracle for anything that ever leaked one.
    // Claims are read only from the verified token, never from the caller, so the
    // browser cannot hand itself another school, role or module set.
    Credentials({
      id: "impersonate",
      name: "Impersonate",
      credentials: { token: { label: "Impersonation token" } },
      authorize: async (creds) => {
        const raw = String(creds?.token ?? "");
        if (!raw || AUTH_SECRETS.length === 0) return null;
        // Accept the rotation window: an impersonation token minted by the API
        // seconds before a rotation deploy must still exchange cleanly.
        let claims: ImpersonationClaims | null = null;
        for (const secret of AUTH_SECRETS) {
          try {
            claims = jwt.verify(raw, secret, { algorithms: ["HS256"] }) as unknown as ImpersonationClaims;
            break;
          } catch {
            // try the next secret
          }
        }
        if (!claims) return null; // bad signature / expired -> no session
        if (!claims.imp?.by || !claims.userId || !claims.school_id) return null;
        return {
          id: claims.userId,
          name: claims.name ?? "User",
          email: "",
          schoolId: claims.school_id,
          schoolName: claims.schoolName ?? "",
          timezone: claims.timezone,
          locale: claims.locale,
          currency: claims.currency,
          roles: claims.roles ?? [],
          permissions: claims.permissions ?? [],
          // An impersonation token carries the TARGET's roles and nothing on
          // loan: the operator is standing in the user's shoes, not borrowing a
          // permission. The refresh fills this in if the target has a grant.
          elevated: [],
          modules: claims.modules ?? [],
          mfaEnrollRequired: false, // already satisfied by the OPERATOR's own login
          passwordExpired: false,
          // DELIBERATELY UNSET. An impersonation session is minted from the
          // operator's own act, not from the target's password: it is short,
          // audited, and step-up gated. Binding it to the target's password
          // epoch would revoke it the moment that user changed their password
          // mid-investigation, and stamping a 0 would revoke it immediately for
          // anyone who has ever set one. The refresh still revokes it on lock,
          // account status and school status like any other session.
          impersonatedBy: claims.imp.by,
        };
      },
    }),
  ],
  callbacks: {
    // Presence check only. The matched (protected) routes' actual redirects —
    // including the super_admin MFA-enrolment mandate — are handled explicitly in
    // middleware.ts via the auth() wrapper (a returned NextResponse is reliably
    // honoured there, unlike a Response from this callback).
    authorized: ({ auth }) => Boolean(auth?.user),
    jwt: async ({ token, user }) => {
      if (user) {
        const u = user as unknown as {
          id: string;
          schoolId: string;
          schoolName: string;
          roles: string[];
          permissions: string[];
          elevated?: string[];
          modules: string[];
          timezone?: string;
          locale?: string;
          currency?: string;
          mfaEnrollRequired: boolean;
          passwordExpired: boolean;
          passwordChangedAtMs?: number;
          impersonatedBy?: string;
        };
        token.userId = u.id;
        token.schoolId = u.schoolId;
        token.schoolName = u.schoolName;
        token.roles = u.roles;
        // SECURITY/SIZE: the PERMISSIONS array is deliberately NOT stored in the
        // cookie. A principal's ~97 permission strings pushed the encrypted
        // session cookie to ~3.7 KB — past nginx's default 4 KB header buffer
        // (502s) and brushing the browser's own ~4 KB cookie cap. Roles are the
        // compact source of truth: the session callback derives UI permissions
        // via permissionsForRoles(), and the API guard expands roles server-side
        // for authorization. `permissions: undefined` also scrubs the big array
        // out of PRE-EXISTING cookies on their first refresh.
        token.permissions = undefined;
        // The exception to "roles only": an elevation grant is NOT derivable
        // from a role, so the few strings it adds have to be carried. Bounded by
        // the user's active grants — typically none, and the smoke test asserts
        // the whole cookie stays under 3 KB.
        token.elevated = u.elevated ?? [];
        token.modules = u.modules; // bounded by the module catalog (small)
        // Three short strings — the school's region. Needed on BOTH the server
        // render and the client hydration, and identical on each, or React throws
        // a hydration mismatch. The cookie has ample headroom (smoke asserts 3 KB).
        token.timezone = u.timezone;
        token.locale = u.locale;
        token.currency = u.currency;
        token.mfaEnrollRequired = u.mfaEnrollRequired;
        token.passwordExpired = u.passwordExpired;
        // Absent for an impersonation session, which is exempt by design.
        if (typeof u.passwordChangedAtMs === "number") token.passwordChangedAtMs = u.passwordChangedAtMs;
        // Present ONLY for a session minted by the impersonate provider. It must
        // survive into the API token (see apiToken.ts) or impersonated actions
        // become unattributable in the audit log again.
        token.impersonatedBy = u.impersonatedBy;
        token.claimsAt = Date.now(); // login-fresh claims
        return token;
      }

      // Existing session: periodic claim revalidation (see the header comment).
      // SECURITY/RUNTIME: the refresh mints an HS256 bearer with `jsonwebtoken`
      // (Node `crypto`), which the Edge runtime lacks — and this same callback
      // runs inside the Edge middleware. Calling it there throws
      // "edge runtime does not support crypto", which Auth.js surfaces as a
      // JWTSessionError and the middleware then treats the user as logged out.
      // Middleware only needs a PRESENCE check, so skip the refresh in Edge; it
      // still runs on every Node-runtime server render within the same cadence,
      // so revocation lands within the interval regardless.
      if (process.env.NEXT_RUNTIME === "edge") return token;
      const now = Date.now();
      const claimsAt = typeof token.claimsAt === "number" ? token.claimsAt : 0;
      const triedAt = typeof token.claimsTriedAt === "number" ? token.claimsTriedAt : 0;
      if (now - claimsAt < CLAIMS_REFRESH_MS || now - triedAt < CLAIMS_RETRY_MS) return token;
      token.claimsTriedAt = now;
      const fresh = await fetchRefreshedClaims(token);
      if (fresh === "revoked") return null; // SECURITY: kills the session NOW
      if (fresh) {
        token.schoolName = fresh.schoolName;
        token.roles = fresh.roles;
        // Never re-inflate the cookie: permissions stay OUT (derived from roles
        // everywhere) — this also scrubs pre-slim cookies on their first refresh.
        token.permissions = undefined;
        token.modules = fresh.modules;
        // Elevation, and its EXPIRY: a grant that has lapsed comes back absent,
        // so the affordance disappears with the authority behind it.
        token.elevated = fresh.elevated ?? [];
        token.mfaEnrollRequired = fresh.mfaEnrollRequired;
        token.passwordExpired = fresh.passwordExpired;
        // Kept in step so the session that legitimately changed the password can
        // be re-established by signing in again, rather than fighting its own
        // stale claim.
        token.passwordChangedAtMs = fresh.passwordChangedAtMs;
        token.claimsAt = now;
      }
      return token;
    },
    session: ({ session, token }) => {
      session.user.id = token.userId as string;
      session.user.schoolId = token.schoolId as string;
      session.user.schoolName = token.schoolName as string;
      session.user.roles = (token.roles as string[]) ?? [];
      // Derived, never stored: expand roles via the SAME map the seed writes to
      // the DB (@sms/types role-map — single source of truth), so UI gating
      // matches the API's own role→permission resolution. Pure function — safe
      // in the Edge middleware. Pre-slim cookies that still carry permissions
      // are ignored in favour of the derivation (consistency over legacy).
      //
      // PLUS anything held by an ACTIVE elevation grant, which is not derivable
      // from a role and so had to be carried. Without it the UI contradicted the
      // API: the guard merges a grant and answers the request, while the nav,
      // the dashboard tiles and every page gate here still said no — so an
      // approved, audited elevation reached only somebody willing to call the
      // API by hand. This is UI gating, not authorization; the API remains the
      // gate, and `elevated` has already been filtered to elevatable
      // permissions server-side.
      const elevated = (token.elevated as string[] | undefined) ?? [];
      session.user.permissions = sessionPermissions((token.roles as string[]) ?? [], elevated);
      // Named separately so the UI can SAY that a screen is on loan rather than
      // silently presenting borrowed authority as the user's own.
      session.user.elevated = elevated;
      session.user.modules = (token.modules as string[]) ?? [];
      // Region: defaults keep an OLD session (minted before this existed) rendering
      // exactly as it did, rather than blank.
      session.user.timezone = (token.timezone as string) || PLATFORM_REGION.timezone;
      session.user.locale = (token.locale as string) || PLATFORM_REGION.locale;
      session.user.currency = (token.currency as string) || PLATFORM_REGION.currency;
      session.user.mfaEnrollRequired = (token.mfaEnrollRequired as boolean) ?? false;
      session.user.passwordExpired = (token.passwordExpired as boolean) ?? false;
      session.user.impersonatedBy = (token.impersonatedBy as string | undefined) ?? undefined;
      return session;
    },
  },
});

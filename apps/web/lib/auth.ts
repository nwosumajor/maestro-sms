// =============================================================================
// Auth.js (NextAuth v5) — owns login + session, issues the JWT (CLAUDE.md).
// =============================================================================
// The Credentials provider verifies the password against the REAL user store via
// the stateless API `POST /auth/login` (bcrypt + DB lookup there). The API
// returns the user's tenant + RBAC claims, which we stamp onto the signed JWT;
// the API then verifies that JWT on every request.
// =============================================================================

import NextAuth from "next-auth";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import jwt from "jsonwebtoken";
import { permissionsForRoles } from "@sms/types";

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
  mfaEnrollRequired: boolean;
  passwordExpired: boolean;
}

/** Re-fetch the caller's claims. "revoked" ⇒ kill the session; null ⇒ transient
 *  failure, keep what we have. The bearer is minted from the token's own claims
 *  (same shape apiToken.ts mints from the session — auth() is unavailable here). */
async function fetchRefreshedClaims(token: JWT): Promise<RefreshedClaims | "revoked" | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret || !token.userId || !token.schoolId) return null;
  const bearer = jwt.sign(
    {
      userId: token.userId,
      school_id: token.schoolId,
      // Roles only — the API guard expands roles → permissions server-side.
      roles: token.roles ?? [],
      ...(token.impersonatedBy ? { imp: { by: token.impersonatedBy } } : {}),
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
}

/** Claims the API stamps into an impersonation token (POST /operator/impersonate). */
interface ImpersonationClaims {
  userId: string;
  school_id: string;
  name?: string;
  schoolName?: string;
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
  modules: string[];
  mfaEnrollRequired?: boolean;
  passwordExpired?: boolean;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Self-hosted: trust the deployment host (NextAuth refuses otherwise -> 500).
  trustHost: true,
  // Rotation window (see AUTH_SECRETS above); [AUTH_SECRET] alone when no
  // rotation is in progress — identical behaviour to the plain-string default.
  ...(AUTH_SECRETS.length > 0 ? { secret: AUTH_SECRETS } : {}),
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email" },
        password: { label: "Password" },
        code: { label: "2FA code" },
      },
      authorize: async (creds) => {
        const email = String(creds?.email ?? "");
        const password = String(creds?.password ?? "");
        const mfaCode = creds?.code ? String(creds.code) : undefined;
        if (!email || !password) return null;
        const res = await fetch(`${API_BASE}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
          roles: u.roles,
          permissions: u.permissions,
          modules: u.modules ?? [],
          mfaEnrollRequired: u.mfaEnrollRequired ?? false,
          passwordExpired: u.passwordExpired ?? false,
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
          roles: claims.roles ?? [],
          permissions: claims.permissions ?? [],
          modules: claims.modules ?? [],
          mfaEnrollRequired: false, // already satisfied by the OPERATOR's own login
          passwordExpired: false,
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
          modules: string[];
          mfaEnrollRequired: boolean;
          passwordExpired: boolean;
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
        token.modules = u.modules; // bounded by the module catalog (small)
        token.mfaEnrollRequired = u.mfaEnrollRequired;
        token.passwordExpired = u.passwordExpired;
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
        token.mfaEnrollRequired = fresh.mfaEnrollRequired;
        token.passwordExpired = fresh.passwordExpired;
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
      session.user.permissions = permissionsForRoles((token.roles as string[]) ?? []);
      session.user.modules = (token.modules as string[]) ?? [];
      session.user.mfaEnrollRequired = (token.mfaEnrollRequired as boolean) ?? false;
      session.user.passwordExpired = (token.passwordExpired as boolean) ?? false;
      session.user.impersonatedBy = (token.impersonatedBy as string | undefined) ?? undefined;
      return session;
    },
  },
});

// =============================================================================
// Auth.js (NextAuth v5) — owns login + session, issues the JWT (CLAUDE.md).
// =============================================================================
// The Credentials provider verifies the password against the REAL user store via
// the stateless API `POST /auth/login` (bcrypt + DB lookup there). The API
// returns the user's tenant + RBAC claims, which we stamp onto the signed JWT;
// the API then verifies that JWT on every request.
// =============================================================================

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import jwt from "jsonwebtoken";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

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
        const secret = process.env.AUTH_SECRET;
        if (!raw || !secret) return null;
        let claims: ImpersonationClaims;
        try {
          claims = jwt.verify(raw, secret, { algorithms: ["HS256"] }) as unknown as ImpersonationClaims;
        } catch {
          return null; // bad signature / expired -> no session
        }
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
    jwt: ({ token, user }) => {
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
        token.permissions = u.permissions;
        token.modules = u.modules;
        token.mfaEnrollRequired = u.mfaEnrollRequired;
        token.passwordExpired = u.passwordExpired;
        // Present ONLY for a session minted by the impersonate provider. It must
        // survive into the API token (see apiToken.ts) or impersonated actions
        // become unattributable in the audit log again.
        token.impersonatedBy = u.impersonatedBy;
      }
      return token;
    },
    session: ({ session, token }) => {
      session.user.id = token.userId as string;
      session.user.schoolId = token.schoolId as string;
      session.user.schoolName = token.schoolName as string;
      session.user.roles = (token.roles as string[]) ?? [];
      session.user.permissions = (token.permissions as string[]) ?? [];
      session.user.modules = (token.modules as string[]) ?? [];
      session.user.mfaEnrollRequired = (token.mfaEnrollRequired as boolean) ?? false;
      session.user.passwordExpired = (token.passwordExpired as boolean) ?? false;
      session.user.impersonatedBy = (token.impersonatedBy as string | undefined) ?? undefined;
      return session;
    },
  },
});

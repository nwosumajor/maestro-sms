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

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

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
        };
        token.userId = u.id;
        token.schoolId = u.schoolId;
        token.schoolName = u.schoolName;
        token.roles = u.roles;
        token.permissions = u.permissions;
        token.modules = u.modules;
        token.mfaEnrollRequired = u.mfaEnrollRequired;
        token.passwordExpired = u.passwordExpired;
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
      return session;
    },
  },
});

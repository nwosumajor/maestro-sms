import type { DefaultSession } from "next-auth";

// Augment the session/JWT with the tenant + authz claims the app relies on.
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      schoolId: string;
      schoolName: string;
      roles: string[];
      permissions: string[];
      /** Subscription-enabled modules — drives nav visibility. */
      modules: string[];
      /** WHERE THE SCHOOL IS. Carried in the session so the server render and the
       *  client hydration format from the SAME values — a runtime default differs
       *  between Node and the browser, which is a hydration mismatch. */
      timezone: string;
      locale: string;
      currency: string;
      /** super_admin mandated MFA but the user hasn't enrolled — gate to /account. */
      mfaEnrollRequired: boolean;
      /** Password older than 30 days (non-super_admin) — gate to /account/password. */
      passwordExpired: boolean;
      /** Set ONLY on an impersonated session: the operator's userId. Drives the
       *  banner AND rides into the API token so the audit log stays attributable. */
      impersonatedBy?: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    schoolId?: string;
    schoolName?: string;
    roles?: string[];
    permissions?: string[];
    modules?: string[];
    timezone?: string;
    locale?: string;
    currency?: string;
    mfaEnrollRequired?: boolean;
    /** Epoch ms of the password this session was issued under — the API revokes
     *  a session older than the stored password. */
    passwordChangedAtMs?: number;
    impersonatedBy?: string;
    passwordExpired?: boolean;
  }
}

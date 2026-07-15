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
    mfaEnrollRequired?: boolean;
    impersonatedBy?: string;
    passwordExpired?: boolean;
  }
}

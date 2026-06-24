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
  }
}

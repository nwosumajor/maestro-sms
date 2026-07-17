import "server-only";
import jwt from "jsonwebtoken";
import { auth } from "@/lib/auth";

/**
 * Mint a short-lived HS256 service token from the current session, for the API
 * to verify. The signing secret never leaves the server. // SECURITY: tenant +
 * authz claims come from the verified session, never from client input.
 */
export async function bearerForSession(): Promise<string | null> {
  const session = await auth();
  if (!session?.user) return null;
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return jwt.sign(
    {
      userId: session.user.id,
      school_id: session.user.schoolId,
      // Roles ONLY — the API's PermissionGuard expands roles → permissions from
      // the seeded tables (cached). Keeping the ~97-string permissions array out
      // of every bearer mirrors the slim session cookie (the array is what blew
      // past proxy header buffers) and means a re-seeded permission change takes
      // effect API-side within its 60s cache, not at next login.
      roles: session.user.roles,
      // Impersonation: the principal IS the target (same tenant/roles/RLS), so this
      // is what lets the API attribute every action to the operator driving it.
      // Dropping it here would re-open the audit hole the API fix closed.
      ...(session.user.impersonatedBy ? { imp: { by: session.user.impersonatedBy } } : {}),
    },
    secret,
    { algorithm: "HS256", expiresIn: "5m" },
  );
}

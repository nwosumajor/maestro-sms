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
      roles: session.user.roles,
      permissions: session.user.permissions,
    },
    secret,
    { algorithm: "HS256", expiresIn: "5m" },
  );
}

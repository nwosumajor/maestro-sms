import { UnauthorizedException } from "@nestjs/common";
import jwt from "jsonwebtoken";
import type { Principal } from "./principal";

/**
 * Verify the Auth.js-issued JWT (HS256, shared AUTH_SECRET) and project it onto a
 * Principal. The API is stateless: it VERIFIES tokens, never issues sessions.
 * // SECURITY: school_id/roles/permissions come ONLY from the verified token.
 */
export function verifyToken(token: string): Principal {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new UnauthorizedException("Auth is not configured");
  let payload: Record<string, unknown>;
  try {
    // Pin HS256: tokens are symmetric-signed with AUTH_SECRET. Pinning the
    // algorithm forecloses any algorithm-substitution trickery. // SECURITY
    payload = jwt.verify(token, secret, { algorithms: ["HS256"] }) as Record<
      string,
      unknown
    >;
  } catch {
    throw new UnauthorizedException("Invalid token");
  }
  const userId = (payload.userId ?? payload.sub) as string | undefined;
  const schoolId = (payload.school_id ?? payload.schoolId) as string | undefined;
  if (!userId || !schoolId) throw new UnauthorizedException("Token missing tenant claims");
  return {
    userId,
    schoolId,
    roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
    permissions: Array.isArray(payload.permissions) ? (payload.permissions as string[]) : [],
  };
}

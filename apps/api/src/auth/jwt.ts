import { UnauthorizedException } from "@nestjs/common";
import type { Principal } from "./principal";
import { verifyHs256, verifyingSecrets } from "./secrets";

/**
 * Verify the Auth.js-issued JWT (HS256, shared AUTH_SECRET — with the
 * AUTH_SECRET_PREVIOUS rotation window, see secrets.ts) and project it onto a
 * Principal. The API is stateless: it VERIFIES tokens, never issues sessions.
 * // SECURITY: school_id/roles/permissions come ONLY from the verified token.
 */
export function verifyToken(token: string): Principal {
  if (verifyingSecrets().length === 0) throw new UnauthorizedException("Auth is not configured");
  let payload: Record<string, unknown>;
  try {
    // HS256 stays pinned inside verifyHs256 — forecloses algorithm substitution.
    payload = verifyHs256(token);
  } catch {
    throw new UnauthorizedException("Invalid token");
  }
  const userId = (payload.userId ?? payload.sub) as string | undefined;
  const schoolId = (payload.school_id ?? payload.schoolId) as string | undefined;
  if (!userId || !schoolId) throw new UnauthorizedException("Token missing tenant claims");
  // `imp.by` marks an impersonation token minted by /operator/impersonate. It
  // grants NOTHING — the claims above already are the target's — it exists so the
  // audit log can say "the owner did this, as them" instead of silently
  // attributing the action to the target (Golden Rule #5).
  const imp = payload.imp as { by?: string } | undefined;
  return {
    userId,
    schoolId,
    roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
    permissions: Array.isArray(payload.permissions) ? (payload.permissions as string[]) : [],
    ...(imp?.by ? { impersonatedBy: String(imp.by) } : {}),
  };
}

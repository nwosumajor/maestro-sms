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
  // A PURPOSE-SCOPED TOKEN IS NOT A SESSION.
  //
  // This accepted `sub` for `userId` and `schoolId` for `school_id`, and checked
  // nothing else — which is exactly the shape of every OTHER token this platform
  // signs with the same secret: the invite link (7 days, emailed, carried in a
  // URL), the password-reset link (30 minutes, likewise), the step-up token and
  // the document-upload token. All of them therefore authenticated as sessions.
  //
  // Measured live with an invite token as `Authorization: Bearer`:
  //   garbage token       -> 401
  //   wrong-secret token  -> 401
  //   INVITE token        -> 403   (denied for permissions, i.e. it AUTHENTICATED)
  //   GET /auth/refresh   -> 200, roles ["teacher"], 56 permissions
  //
  // So a forwarded invite email, a link in browser history or a shared device
  // yielded the target's FULL authority, for seven days, and kept doing so after
  // the invite had been used: single-use is enforced at the accept endpoint
  // (`passwordChangedAt IS NULL`), which this path never touches.
  //
  // `invite.ts` states the property as already true — "a session JWT can never
  // be replayed here (AND VICE VERSA — the API pins algorithms + checks the
  // purpose)". The first half was enforced; the "vice versa" was not.
  //
  // REFUSES THE MARKER ITSELF, not a list of known values. A list of purposes to
  // reject is one a new token kind is added without, and this is the check that
  // has to hold for tokens nobody has written yet. Session bearers carry neither
  // claim: `apps/web/lib/apiToken.ts` mints userId/school_id/roles(/imp), and
  // the operator's impersonation token the same.
  if (payload.purpose !== undefined || payload.typ !== undefined) {
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
  // Carried through so the refresh can revoke a session issued under a password
  // that has since been changed. It grants nothing and is only ever compared.
  const pwdAt = payload.pwd_at;
  return {
    userId,
    schoolId,
    ...(typeof pwdAt === "number" ? { passwordChangedAtMs: pwdAt } : {}),
    roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
    permissions: Array.isArray(payload.permissions) ? (payload.permissions as string[]) : [],
    ...(imp?.by ? { impersonatedBy: String(imp.by) } : {}),
  };
}

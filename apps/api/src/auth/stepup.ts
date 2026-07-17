// =============================================================================
// Step-up re-authentication tokens
// =============================================================================
// A short-lived (5 min) signed token proving the user RE-authenticated recently.
// Required (via @RequireStepUp) before the most sensitive actions — editing a
// medical record, disabling MFA, etc. — even within an active session. Signed
// with the shared AUTH_SECRET, like the session JWT, but with typ:"stepup" and
// bound to the user + tenant so it can't be replayed for another principal.
// =============================================================================

import jwt from "jsonwebtoken";
import { signingSecret, verifyHs256, verifyingSecrets } from "./secrets";

const TTL_SECONDS = 300;

export function signStepUp(userId: string, schoolId: string): { token: string; expiresIn: number } {
  const token = jwt.sign({ sub: userId, schoolId, typ: "stepup" }, signingSecret(), {
    algorithm: "HS256",
    expiresIn: TTL_SECONDS,
  });
  return { token, expiresIn: TTL_SECONDS };
}

export function verifyStepUp(token: string, userId: string, schoolId: string): boolean {
  if (verifyingSecrets().length === 0) return false;
  try {
    // HS256 stays pinned inside verifyHs256; accepts the rotation window.
    const p = verifyHs256(token) as { typ?: string; sub?: string; schoolId?: string };
    return p.typ === "stepup" && p.sub === userId && p.schoolId === schoolId;
  } catch {
    return false;
  }
}

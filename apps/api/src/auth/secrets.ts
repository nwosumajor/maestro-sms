// =============================================================================
// Auth-secret lifecycle — dual-secret rotation window
// =============================================================================
// One symmetric secret (AUTH_SECRET) signs every token family: session bearers,
// step-up, ws tickets, invites, password resets, impersonation. Rotating it used
// to be all-or-nothing (instant fleet-wide logout). AUTH_SECRET_PREVIOUS opens a
// graceful window: NEW tokens are always signed with AUTH_SECRET; verification
// tries AUTH_SECRET first, then AUTH_SECRET_PREVIOUS. Rotation = move the old
// value to *_PREVIOUS, set a fresh AUTH_SECRET, deploy, drop *_PREVIOUS after
// the longest-lived token (7d invites) has aged out (runbook: 30 days).
// // SECURITY: HS256 stays pinned at every call site; the previous secret can
// only VERIFY, never sign — a leak of the old secret is closed by clearing it.
// =============================================================================

import jwt from "jsonwebtoken";

/** The signing secret (current only). Throws when auth is not configured. */
export function signingSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not configured");
  return secret;
}

/** Secrets accepted for VERIFICATION: current first, then previous (if set). */
export function verifyingSecrets(): string[] {
  return [process.env.AUTH_SECRET, process.env.AUTH_SECRET_PREVIOUS].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
}

/**
 * Verify an HS256 token against the rotation window. Returns the payload or
 * throws the last verification error (so expiry/shape errors surface exactly as
 * they did in the single-secret world).
 */
export function verifyHs256(token: string): Record<string, unknown> {
  const secrets = verifyingSecrets();
  if (secrets.length === 0) throw new Error("AUTH_SECRET is not configured");
  let lastErr: unknown = new Error("verification failed");
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret, { algorithms: ["HS256"] }) as Record<string, unknown>;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

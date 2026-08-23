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
import { isPublishedSecret } from "./published-secrets";

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

/**
 * Minimum length for an HS256 signing key.
 *
 * Everything this platform issues is signed with it: session bearers, the
 * ws-ticket, step-up tokens, invite links, password-reset links and the local
 * storage presigns. A short key is a forgeable session for every user in every
 * school.
 */
const MIN_SECRET_BYTES = 32;

/**
 * Values that are obviously not a secret.
 *
 * `.env.example` shipped `change-me-32-char-min-secret` — a value PUBLISHED IN
 * THE REPOSITORY, twenty-eight characters long despite its own advice, and the
 * one a deployment is likeliest to inherit by copying the example. Anyone who
 * has read this repo could mint a session for any user in any school, a step-up
 * token to pass re-auth, or a password-reset link. It is the same shape as the
 * demo-seed password this project already treats as a platform compromise.
 */
const PLACEHOLDERS = [/^change-?me/i, /^secret$/i, /^dev(elopment)?$/i, /^test$/i, /^password/i];

/** What is wrong with the signing secret, or null if nothing is. */
export function secretProblem(): string | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return "AUTH_SECRET is not set";
  if (isPublishedSecret(secret)) {
    return "AUTH_SECRET is a value this repository has published, so it is not a secret";
  }
  if (PLACEHOLDERS.some((re) => re.test(secret))) {
    return "AUTH_SECRET is still the example placeholder, which is published in this repository";
  }
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    return `AUTH_SECRET is ${Buffer.byteLength(secret, "utf8")} bytes; ${MIN_SECRET_BYTES} is the minimum for HS256`;
  }
  return null;
}

/**
 * Refuse to start in production on a secret anyone could guess.
 *
 * Production only, for the same reason the field-crypto assertion is: local work
 * must not need a generated secret. Outside production it warns instead — and it
 * does warn, because a developer running with the placeholder should know that
 * every token their stack issues is forgeable.
 *
 * // SECURITY: this is the key for the WHOLE token family. A weak one is not a
 * degraded feature, it is authentication that can be bypassed by anybody.
 */
export function assertAuthSecretUsable(): void {
  const problem = secretProblem();
  if (!problem) return;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `${problem}. Refusing to start: this key signs every session, step-up token, invite and ` +
        `password-reset link. Generate one with \`openssl rand -base64 32\`.`,
    );
  }
  // eslint-disable-next-line no-console -- reason: boot-time security notice
  console.warn(`[auth] ${problem} — every token this stack issues is forgeable.`);
}

// =============================================================================
// Handshake authentication for the game-server (spec §11 step 3 — the auth half).
// =============================================================================
// The standalone steps (1–2) trusted a client-sent display name. Real play must
// derive identity from the SAME verified Auth.js JWT the SMS API trusts, so the
// live transport can enforce tenant isolation (Golden Rules #2/#3) and never lets
// a client assert its own userId/school_id.
//
// This mirrors `apps/api/src/auth/jwt.ts`'s contract EXACTLY — HS256 signed with
// the shared AUTH_SECRET, claims `userId|sub` + `school_id|schoolId` + `roles` —
// but is hand-rolled on `node:crypto` so the standalone server pulls in NO extra
// dependency. // SECURITY: HS256 is pinned; `alg: none` and any other algorithm
// are rejected, foreclosing algorithm-substitution attacks. The signature is
// compared in constant time, and `exp`/`nbf` are enforced.
// =============================================================================

import { createHmac, timingSafeEqual } from "node:crypto";

/** Verified identity projected from the JWT — the live transport's source of truth. */
export interface GamePrincipal {
  userId: string;
  schoolId: string;
  roles: string[];
  /** Display name from the token; falls back to a short id slice if absent. */
  name: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Verify an HS256 JWT against `secret` and project it onto a GamePrincipal.
 * Throws `AuthError` on any failure (bad shape, wrong/none algorithm, bad
 * signature, expired/not-yet-valid, or missing tenant claims).
 */
export function verifyJwt(token: string, secret: string, now: number = Date.now()): GamePrincipal {
  if (!secret) throw new AuthError("auth is not configured");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("malformed token");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = decodeJson(headerB64, "header");
  if (header.alg !== "HS256") throw new AuthError("unexpected token algorithm");

  // Recompute the signature over `header.payload` and compare in constant time.
  const expected = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureB64, "base64url");
  } catch {
    throw new AuthError("malformed signature");
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new AuthError("invalid signature");
  }

  const payload = decodeJson(payloadB64, "payload");
  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp === "number" && nowSec >= payload.exp) throw new AuthError("token expired");
  if (typeof payload.nbf === "number" && nowSec < payload.nbf) throw new AuthError("token not yet valid");

  const userId = (payload.userId ?? payload.sub) as string | undefined;
  const schoolId = (payload.school_id ?? payload.schoolId) as string | undefined;
  if (!userId || !schoolId) throw new AuthError("token missing tenant claims");

  const name =
    typeof payload.name === "string" && payload.name.trim().length > 0
      ? payload.name.trim().slice(0, 40)
      : `Player ${userId.slice(0, 4)}`;

  return {
    userId,
    schoolId,
    roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
    name,
  };
}

function decodeJson(segment: string, which: string): Record<string, unknown> {
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const obj: unknown = JSON.parse(json);
    if (typeof obj !== "object" || obj === null) throw new Error("not an object");
    return obj as Record<string, unknown>;
  } catch {
    throw new AuthError(`malformed token ${which}`);
  }
}

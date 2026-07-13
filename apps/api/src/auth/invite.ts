// =============================================================================
// Invite tokens — one-time "set your password" links for provisioned accounts
// =============================================================================
// Signed HS256 with the same AUTH_SECRET the session tokens use (one secret, one
// trust root). A token is scoped by `purpose: "invite"` so a session JWT can
// never be replayed here (and vice versa — the API pins algorithms + checks the
// purpose). Single-use is enforced at ACCEPT time, not here: an invite is only
// honoured while the account has never set a password (passwordChangedAt IS
// NULL), so a used link is dead even inside its 7-day window.

import jwt from "jsonwebtoken";

const INVITE_PURPOSE = "invite";
const INVITE_TTL = "7d";
const RESET_PURPOSE = "pwreset";
const RESET_TTL = "30m";

export function mintInviteToken(userId: string, schoolId: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not configured");
  return jwt.sign({ sub: userId, school_id: schoolId, purpose: INVITE_PURPOSE }, secret, {
    algorithm: "HS256",
    expiresIn: INVITE_TTL,
  });
}

/** Returns the invite's subject, or null for ANY invalid/expired/wrong-purpose
 *  token (callers answer with one generic error — never leak which check failed). */
export function verifyInviteToken(token: string): { userId: string; schoolId: string } | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] }) as Record<string, unknown>;
    if (payload.purpose !== INVITE_PURPOSE) return null;
    const userId = payload.sub as string | undefined;
    const schoolId = payload.school_id as string | undefined;
    if (!userId || !schoolId) return null;
    return { userId, schoolId };
  } catch {
    return null;
  }
}

// --- Forgot-password reset tokens -------------------------------------------
// Same signing root, DIFFERENT purpose (an invite can't reset an existing
// password and vice versa), short 30-minute TTL. Single-use is enforced by
// binding the token to the password's CURRENT change-timestamp (`pca`): the
// moment the reset lands, passwordChangedAt moves and the token is dead — as is
// every previously-issued reset link for that account.

export function mintPasswordResetToken(
  userId: string,
  schoolId: string,
  passwordChangedAt: Date | null,
): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not configured");
  return jwt.sign(
    { sub: userId, school_id: schoolId, purpose: RESET_PURPOSE, pca: passwordChangedAt?.getTime() ?? 0 },
    secret,
    { algorithm: "HS256", expiresIn: RESET_TTL },
  );
}

export function verifyPasswordResetToken(
  token: string,
): { userId: string; schoolId: string; pca: number } | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] }) as Record<string, unknown>;
    if (payload.purpose !== RESET_PURPOSE) return null;
    const userId = payload.sub as string | undefined;
    const schoolId = payload.school_id as string | undefined;
    const pca = payload.pca;
    if (!userId || !schoolId || typeof pca !== "number") return null;
    return { userId, schoolId, pca };
  } catch {
    return null;
  }
}

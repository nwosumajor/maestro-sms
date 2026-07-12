// =============================================================================
// Staff-attendance helpers (pure)
// =============================================================================
// The clock-in window and lateness boundary are school-local "HH:MM" strings;
// deriving status/window server-side (from the server clock) keeps the client
// display-only. IP checking is a SIGNAL (flag for human review), never a block —
// consistent with the platform's signals-not-verdicts rule.
// =============================================================================

/** Minutes since midnight for an "HH:MM" string; NaN if malformed. */
export function hhmmToMinutes(v: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((v ?? "").trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
}

/** Is `now` inside the [windowStart, windowEnd] clock-in window? */
export function inClockInWindow(windowStart: string, windowEnd: string, now: Date): boolean {
  const start = hhmmToMinutes(windowStart);
  const end = hhmmToMinutes(windowEnd);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= start && cur <= end;
}

/** PRESENT before/at `lateAfter`, LATE after it. */
export function deriveClockInStatus(lateAfter: string, now: Date): "PRESENT" | "LATE" {
  const boundary = hhmmToMinutes(lateAfter);
  if (Number.isNaN(boundary)) return "PRESENT";
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur <= boundary ? "PRESENT" : "LATE";
}

/** Does `ip` match the comma-separated allowlist (exact or prefix like
 *  "197.210.")? Empty/absent list => everything matches (no signal). */
export function ipMatchesAllowlist(ip: string | null | undefined, allowedIps: string | null | undefined): boolean {
  const list = (allowedIps ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
  if (!ip) return false;
  return list.some((a) => (a.endsWith(".") ? ip.startsWith(a) : ip === a));
}

import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify a device batch's HMAC-SHA256 signature (hex) over the EXACT raw body
 *  bytes — re-serialised JSON would not match. Constant-time compare. Pure. */
export function verifyDeviceSignature(
  rawBody: Buffer | undefined,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!rawBody || !signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = signature.trim().toLowerCase();
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(given, "utf8"));
}

/** Is `ts` within ±`skewMs` of now? Replay guard for device batches. */
export function isFreshTimestamp(ts: string, skewMs = 10 * 60 * 1000, now: Date = new Date()): boolean {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return false;
  return Math.abs(now.getTime() - t) <= skewMs;
}

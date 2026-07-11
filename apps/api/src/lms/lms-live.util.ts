// =============================================================================
// LMS live-classroom helpers (pure)
// =============================================================================
// A live session carries an external meeting URL. We validate it to https and,
// for known providers, host-allowlist it — the same defensive posture as the
// video-embed canonicaliser. `isJoinable` derives whether the join window is
// currently open, so the server (not the client) decides when a link is live.
// =============================================================================

import type { LiveProvider } from "@sms/types";

const PROVIDER_HOSTS: Record<Exclude<LiveProvider, "OTHER">, (host: string) => boolean> = {
  ZOOM: (h) => h === "zoom.us" || h.endsWith(".zoom.us"),
  MEET: (h) => h === "meet.google.com",
  JITSI: (h) => h === "meet.jit.si" || h.endsWith(".jitsi.net") || h.endsWith(".8x8.vc"),
};

/** Validate + return a normalised https join URL, or null. Known providers are
 *  host-allowlisted; OTHER accepts any https URL (rendered as a link, never an
 *  iframe). Rejects non-https (blocks javascript:/data: and downgrade). */
export function normalizeJoinUrl(provider: LiveProvider, raw: string): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (provider !== "OTHER") {
    const ok = PROVIDER_HOSTS[provider];
    if (!ok || !ok(host)) return null;
  }
  return u.toString();
}

const JOIN_EARLY_MS = 15 * 60 * 1000; // openable 15 min before start
const JOIN_GRACE_MS = 30 * 60 * 1000; // and until 30 min after the scheduled end

/** Is the session's join window open right now? ENDED/CANCELLED are never
 *  joinable; otherwise the window is [start-15m, start+duration+30m]. */
export function isJoinable(
  status: string,
  startsAt: Date,
  durationMinutes: number,
  now: Date = new Date(),
): boolean {
  if (status === "ENDED" || status === "CANCELLED") return false;
  const start = startsAt.getTime();
  const end = start + Math.max(0, durationMinutes) * 60 * 1000;
  const t = now.getTime();
  return t >= start - JOIN_EARLY_MS && t <= end + JOIN_GRACE_MS;
}

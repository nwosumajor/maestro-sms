// =============================================================================
// LMS live-classroom helpers
// =============================================================================
// The URL rules now live in ONE place — `@sms/types/meeting-link` — shared with
// parent-teacher meeting slots and calendar (staff) meetings, so a link accepted
// on one surface is accepted identically on the others. This module keeps the
// LMS-specific bits: its own status states and its duration-based window.
// =============================================================================

import { normalizeMeetingUrl, MEETING_JOIN_EARLY_MS, MEETING_JOIN_GRACE_MS } from "@sms/types";
import type { LiveProvider } from "@sms/types";

/** Validate + return a normalised https join URL, or null. Delegates to the
 *  shared validator (https-only + per-provider host allowlist). */
export function normalizeJoinUrl(provider: LiveProvider, raw: string): string | null {
  // LiveProvider is a subset of MeetingProvider, so this is a safe widening.
  return normalizeMeetingUrl(provider, raw);
}

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
  return t >= start - MEETING_JOIN_EARLY_MS && t <= end + MEETING_JOIN_GRACE_MS;
}

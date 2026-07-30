// =============================================================================
// Video-meeting join links (pure, shared)
// =============================================================================
// Three surfaces now carry an external meeting URL — LMS live classes,
// parent–teacher meeting slots, and calendar events (staff meetings). They all
// use THIS validation so the rules can't drift between them:
//
//   - https ONLY. This is the security core: it blocks `javascript:` and `data:`
//     URLs (a stored-XSS vector once rendered as a link) and any http downgrade.
//   - Known providers are HOST-ALLOWLISTED, so a "Zoom" meeting cannot actually
//     point at an attacker's domain. OTHER accepts any https URL and is always
//     rendered as a plain link, never an iframe.
//   - The JOIN WINDOW is computed server-side, so the server — not the client —
//     decides when a link is live. A link that leaks early is still unusable.
// =============================================================================

// `URL` is a runtime global in every target (Node >=10, all browsers, RN), but
// @sms/types is deliberately dependency-free — no @types/node and no DOM lib — so
// declare just the surface used here instead of pulling in a typings package.
interface ParsedUrl {
  protocol: string;
  hostname: string;
  toString(): string;
}
declare const URL: { new (input: string): ParsedUrl };

/** Providers a meeting link may name. OTHER = any other https URL. */
export const MEETING_PROVIDERS = ["ZOOM", "MEET", "TEAMS", "JITSI", "OTHER"] as const;
export type MeetingProvider = (typeof MEETING_PROVIDERS)[number];

/** Human labels for pickers. */
export const MEETING_PROVIDER_LABELS: Record<MeetingProvider, string> = {
  ZOOM: "Zoom",
  MEET: "Google Meet",
  TEAMS: "Microsoft Teams",
  JITSI: "Jitsi",
  OTHER: "Other (link)",
};

const PROVIDER_HOSTS: Record<Exclude<MeetingProvider, "OTHER">, (host: string) => boolean> = {
  ZOOM: (h) => h === "zoom.us" || h.endsWith(".zoom.us"),
  MEET: (h) => h === "meet.google.com",
  // Teams meeting links appear on several official hosts: the tenant-agnostic
  // teams.microsoft.com, the consumer teams.live.com, and the *.teams.microsoft.us
  // government clouds.
  TEAMS: (h) =>
    h === "teams.microsoft.com" ||
    h.endsWith(".teams.microsoft.com") ||
    h === "teams.live.com" ||
    h.endsWith(".teams.microsoft.us"),
  JITSI: (h) => h === "meet.jit.si" || h.endsWith(".jitsi.net") || h.endsWith(".8x8.vc"),
};

/**
 * Validate + normalise a join URL for a provider. Returns null when it must be
 * rejected: not a URL, not https, or (for a known provider) not on that
 * provider's hosts.
 */
export function normalizeMeetingUrl(provider: MeetingProvider, raw: string): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let u: ParsedUrl;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (provider !== "OTHER") {
    const ok = PROVIDER_HOSTS[provider];
    if (!ok || !ok(u.hostname.toLowerCase())) return null;
  }
  return u.toString();
}

/** Openable this long BEFORE the scheduled start. */
export const MEETING_JOIN_EARLY_MS = 15 * 60 * 1000;
/** …and this long AFTER the scheduled end (overrun grace). */
export const MEETING_JOIN_GRACE_MS = 30 * 60 * 1000;

/**
 * Is the join window open right now? `endsAt` may be null (a point-in-time
 * event), in which case the window closes GRACE after the start.
 */
export function isMeetingJoinOpen(startsAt: Date, endsAt: Date | null, now: Date = new Date()): boolean {
  const start = startsAt.getTime();
  const end = endsAt ? endsAt.getTime() : start;
  const t = now.getTime();
  return t >= start - MEETING_JOIN_EARLY_MS && t <= end + MEETING_JOIN_GRACE_MS;
}

/** When the join button starts working — shown to attendees who arrive early. */
export function meetingJoinOpensAt(startsAt: Date): Date {
  return new Date(startsAt.getTime() - MEETING_JOIN_EARLY_MS);
}

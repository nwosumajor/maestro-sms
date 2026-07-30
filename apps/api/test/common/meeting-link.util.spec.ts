// =============================================================================
// Shared meeting-link validation (pure)
// =============================================================================
// This validator is the security boundary for every externally-supplied meeting
// URL — LMS live classes, parent-teacher slots and staff calendar events all use
// it. Two properties matter and are tested here:
//   1. https ONLY — blocks javascript:/data: (stored XSS once rendered as a link)
//      and any http downgrade.
//   2. Known providers are HOST-ALLOWLISTED, so a "Zoom" or "Teams" meeting can
//      never actually point at an attacker-controlled domain.

import {
  MEETING_PROVIDERS,
  isMeetingJoinOpen,
  meetingJoinOpensAt,
  normalizeMeetingUrl,
} from "@sms/types";

describe("normalizeMeetingUrl", () => {
  it("accepts each provider's own hosts", () => {
    expect(normalizeMeetingUrl("ZOOM", "https://acme.zoom.us/j/123")).toContain("acme.zoom.us");
    expect(normalizeMeetingUrl("ZOOM", "https://zoom.us/j/123")).toContain("zoom.us");
    expect(normalizeMeetingUrl("MEET", "https://meet.google.com/abc-defg-hij")).toContain("meet.google.com");
    expect(normalizeMeetingUrl("TEAMS", "https://teams.microsoft.com/l/meetup-join/x")).toContain("teams.microsoft.com");
    expect(normalizeMeetingUrl("TEAMS", "https://teams.live.com/meet/123")).toContain("teams.live.com");
    expect(normalizeMeetingUrl("JITSI", "https://meet.jit.si/room")).toContain("meet.jit.si");
  });

  it("REJECTS a look-alike host for a known provider", () => {
    // The whole point of the allowlist: a "Teams"/"Zoom" meeting cannot be a link
    // to somewhere else, however plausible the domain looks.
    expect(normalizeMeetingUrl("TEAMS", "https://teams.microsoft.com.evil.test/x")).toBeNull();
    expect(normalizeMeetingUrl("TEAMS", "https://evil.test/teams.microsoft.com")).toBeNull();
    expect(normalizeMeetingUrl("ZOOM", "https://zoom.us.evil.test/j/1")).toBeNull();
    expect(normalizeMeetingUrl("ZOOM", "https://notzoom.us/j/1")).toBeNull();
    expect(normalizeMeetingUrl("MEET", "https://meet.google.com.evil.test/x")).toBeNull();
  });

  it("REJECTS non-https for every provider (incl. OTHER)", () => {
    for (const p of MEETING_PROVIDERS) {
      expect(normalizeMeetingUrl(p, "http://zoom.us/j/1")).toBeNull();
      expect(normalizeMeetingUrl(p, "javascript:alert(1)")).toBeNull();
      expect(normalizeMeetingUrl(p, "data:text/html,<script>alert(1)</script>")).toBeNull();
    }
  });

  it("OTHER accepts any https URL but still refuses non-https and junk", () => {
    expect(normalizeMeetingUrl("OTHER", "https://webinar.example.test/room/9")).toContain("webinar.example.test");
    expect(normalizeMeetingUrl("OTHER", "http://webinar.example.test/room/9")).toBeNull();
    expect(normalizeMeetingUrl("OTHER", "not a url")).toBeNull();
    expect(normalizeMeetingUrl("OTHER", "")).toBeNull();
    expect(normalizeMeetingUrl("OTHER", "   ")).toBeNull();
  });

  it("is case-insensitive on the host and trims surrounding whitespace", () => {
    expect(normalizeMeetingUrl("ZOOM", "  https://ACME.ZOOM.US/j/5  ")).not.toBeNull();
  });
});

describe("isMeetingJoinOpen", () => {
  const start = new Date("2026-08-03T10:00:00Z");
  const end = new Date("2026-08-03T11:00:00Z");

  it("is closed well before the start", () => {
    expect(isMeetingJoinOpen(start, end, new Date("2026-08-03T09:00:00Z"))).toBe(false);
  });

  it("opens 15 minutes early", () => {
    expect(isMeetingJoinOpen(start, end, new Date("2026-08-03T09:44:00Z"))).toBe(false);
    expect(isMeetingJoinOpen(start, end, new Date("2026-08-03T09:46:00Z"))).toBe(true);
    expect(meetingJoinOpensAt(start).toISOString()).toBe("2026-08-03T09:45:00.000Z");
  });

  it("stays open through the meeting and 30 minutes past the end", () => {
    expect(isMeetingJoinOpen(start, end, new Date("2026-08-03T10:30:00Z"))).toBe(true);
    expect(isMeetingJoinOpen(start, end, new Date("2026-08-03T11:29:00Z"))).toBe(true);
    expect(isMeetingJoinOpen(start, end, new Date("2026-08-03T11:31:00Z"))).toBe(false);
  });

  it("treats a null end as a point-in-time event (grace from the start)", () => {
    expect(isMeetingJoinOpen(start, null, new Date("2026-08-03T10:29:00Z"))).toBe(true);
    expect(isMeetingJoinOpen(start, null, new Date("2026-08-03T10:31:00Z"))).toBe(false);
  });
});

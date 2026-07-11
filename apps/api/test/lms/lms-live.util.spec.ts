// Unit: live-session join-URL validation + join-window derivation (pure).
import { isJoinable, normalizeJoinUrl } from "../../src/lms/lms-live.util";

describe("normalizeJoinUrl", () => {
  it("accepts host-allowlisted provider URLs", () => {
    expect(normalizeJoinUrl("ZOOM", "https://acme.zoom.us/j/123")).toBe("https://acme.zoom.us/j/123");
    expect(normalizeJoinUrl("MEET", "https://meet.google.com/abc-defg-hij")).toBe("https://meet.google.com/abc-defg-hij");
    expect(normalizeJoinUrl("JITSI", "https://meet.jit.si/MyRoom")).toBe("https://meet.jit.si/MyRoom");
  });

  it("accepts any https URL for OTHER", () => {
    expect(normalizeJoinUrl("OTHER", "https://teams.microsoft.com/l/meet/x")).toBe("https://teams.microsoft.com/l/meet/x");
  });

  it("rejects non-https, wrong-host and junk (SSRF/XSS safety)", () => {
    expect(normalizeJoinUrl("ZOOM", "http://acme.zoom.us/j/123")).toBeNull(); // not https
    expect(normalizeJoinUrl("MEET", "https://evil.com/meet")).toBeNull(); // wrong host
    expect(normalizeJoinUrl("ZOOM", "https://evil.com/zoom.us")).toBeNull(); // host is evil.com
    expect(normalizeJoinUrl("OTHER", "javascript:alert(1)")).toBeNull();
    expect(normalizeJoinUrl("OTHER", "")).toBeNull();
    expect(normalizeJoinUrl("MEET", "not a url")).toBeNull();
  });
});

describe("isJoinable", () => {
  const start = new Date("2026-07-11T10:00:00.000Z");
  it("is open from 15m before start until 30m after the scheduled end", () => {
    expect(isJoinable("SCHEDULED", start, 60, new Date("2026-07-11T09:50:00Z"))).toBe(true); // 10m before
    expect(isJoinable("SCHEDULED", start, 60, new Date("2026-07-11T10:30:00Z"))).toBe(true); // mid
    expect(isJoinable("SCHEDULED", start, 60, new Date("2026-07-11T11:25:00Z"))).toBe(true); // within grace
    expect(isJoinable("SCHEDULED", start, 60, new Date("2026-07-11T09:40:00Z"))).toBe(false); // too early
    expect(isJoinable("SCHEDULED", start, 60, new Date("2026-07-11T11:35:00Z"))).toBe(false); // past grace
  });
  it("is never joinable once ENDED or CANCELLED", () => {
    expect(isJoinable("ENDED", start, 60, start)).toBe(false);
    expect(isJoinable("CANCELLED", start, 60, start)).toBe(false);
  });
});

// Unit: staff-attendance window/status/IP-signal helpers (pure).
import { deriveClockInStatus, hhmmToMinutes, inClockInWindow, ipMatchesAllowlist } from "../../src/hr/attendance.util";

// An instant expressed as UTC, plus the zone the school is in. The old helper
// built a date with `setHours` — the MACHINE's local time — so these tests
// agreed with the bug they were covering and would have changed answer on a
// developer laptop set to anything but UTC.
const utc = (h: number, m: number) => new Date(`2026-08-17T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`);
const UTC_ZONE = "UTC";
const at = (h: number, m: number) => utc(h, m);

describe("hhmmToMinutes", () => {
  it("parses valid HH:MM and rejects junk", () => {
    expect(hhmmToMinutes("08:30")).toBe(510);
    expect(hhmmToMinutes("6:05")).toBe(365);
    expect(Number.isNaN(hhmmToMinutes("25:00"))).toBe(true);
    expect(Number.isNaN(hhmmToMinutes("nope"))).toBe(true);
  });
});

describe("inClockInWindow", () => {
  it("is open inside [start,end] and closed outside", () => {
    expect(inClockInWindow("06:00", "10:00", at(7, 30), UTC_ZONE)).toBe(true);
    expect(inClockInWindow("06:00", "10:00", at(10, 0), UTC_ZONE)).toBe(true);
    expect(inClockInWindow("06:00", "10:00", at(5, 59), UTC_ZONE)).toBe(false);
    expect(inClockInWindow("06:00", "10:00", at(12, 0), UTC_ZONE)).toBe(false);
  });
});

describe("deriveClockInStatus", () => {
  it("PRESENT up to lateAfter, LATE after", () => {
    expect(deriveClockInStatus("08:00", at(7, 59), UTC_ZONE)).toBe("PRESENT");
    expect(deriveClockInStatus("08:00", at(8, 0), UTC_ZONE)).toBe("PRESENT");
    expect(deriveClockInStatus("08:00", at(8, 1), UTC_ZONE)).toBe("LATE");
  });
});

// =============================================================================
// The school's clock, not the server's
// =============================================================================
// `lateAfter`, `windowStart` and `windowEnd` are wall-clock times the SCHOOL
// configured. All three were compared with `Date#getHours()` — the server
// process's zone, which in a container is UTC. The kiosk's DATE had already been
// corrected to the school's day; these three comparisons beside it had not.
//
// Take one instant — 23:30 UTC — and ask three schools what time it is:
//
//   Lagos (UTC+1)      00:30, the next day
//   Singapore (UTC+8)  07:30, the next day   ← the working morning
//   Toronto (UTC-5)    18:30, the same day
//
// On a UTC server every one of them was judged as 23:30. For Singapore that
// meant a 07:30 arrival was outside a 06:00–10:00 window and REFUSED — the kiosk
// telling every member of staff, every morning, that they were outside hours
// their own school had set. Lateness failed the other way and silently: nobody
// in Singapore could ever be marked LATE, because their whole morning lands on
// the previous UTC day.
// =============================================================================
const MORNING_IN_SINGAPORE = new Date("2026-08-17T23:30:00.000Z"); // 07:30 next day, SGT

describe("the clock-in window is the SCHOOL's clock", () => {
  it("opens for the school whose morning it actually is", () => {
    expect(inClockInWindow("06:00", "10:00", MORNING_IN_SINGAPORE, "Asia/Singapore")).toBe(true);
  });

  it("stays closed for a school where that instant is the middle of the night", () => {
    // 00:30 in Lagos — correctly outside a 06:00–10:00 window.
    expect(inClockInWindow("06:00", "10:00", MORNING_IN_SINGAPORE, "Africa/Lagos")).toBe(false);
  });

  it("is closed on a UTC server reading 23:30 — the behaviour being fixed", () => {
    expect(inClockInWindow("06:00", "10:00", MORNING_IN_SINGAPORE, "UTC")).toBe(false);
  });
});

describe("lateness is the SCHOOL's clock", () => {
  it("marks a Singapore arrival after 08:00 local LATE", () => {
    // 00:30 UTC = 08:30 SGT.
    const at0830sgt = new Date("2026-08-18T00:30:00.000Z");
    expect(deriveClockInStatus("08:00", at0830sgt, "Asia/Singapore")).toBe("LATE");
    // The old server-clock reading of the same instant: 00:30, comfortably
    // "PRESENT" — which is why nobody there was ever late.
    expect(deriveClockInStatus("08:00", at0830sgt, "UTC")).toBe("PRESENT");
  });

  it("marks a Lagos arrival after 08:00 local LATE", () => {
    // 07:30 UTC = 08:30 WAT. One hour out is enough to lose the boundary.
    const at0830wat = new Date("2026-08-18T07:30:00.000Z");
    expect(deriveClockInStatus("08:00", at0830wat, "Africa/Lagos")).toBe("LATE");
    expect(deriveClockInStatus("08:00", at0830wat, "UTC")).toBe("PRESENT");
  });

  it("still marks an on-time arrival PRESENT", () => {
    const at0745wat = new Date("2026-08-18T06:45:00.000Z"); // 07:45 WAT
    expect(deriveClockInStatus("08:00", at0745wat, "Africa/Lagos")).toBe("PRESENT");
  });

  it("falls back rather than declaring everybody late on a bad zone", () => {
    // An unusable timezone must not decide attendance; same posture as the date
    // helper, which falls back to UTC rather than losing the day.
    const at0730utc = new Date("2026-08-18T07:30:00.000Z");
    expect(deriveClockInStatus("08:00", at0730utc, "Not/AZone")).toBe("PRESENT");
  });
});

describe("ipMatchesAllowlist", () => {
  it("exact + prefix matching; empty list matches everything (no signal)", () => {
    expect(ipMatchesAllowlist("197.210.55.1", "197.210.")).toBe(true);
    expect(ipMatchesAllowlist("197.210.55.1", "10.0.0.1, 197.210.")).toBe(true);
    expect(ipMatchesAllowlist("41.58.2.9", "197.210.")).toBe(false);
    expect(ipMatchesAllowlist("41.58.2.9", "")).toBe(true);
    expect(ipMatchesAllowlist(null, "197.210.")).toBe(false);
    expect(ipMatchesAllowlist(null, null)).toBe(true);
  });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
import { createHmac } from "node:crypto";
import { isFreshTimestamp, verifyDeviceSignature } from "../../src/hr/attendance.util";

describe("verifyDeviceSignature (device HMAC, pure)", () => {
  const secret = "shhh-device-secret";
  const body = Buffer.from(JSON.stringify({ timestamp: "2026-07-12T08:00:00Z", events: [] }));
  const good = createHmac("sha256", secret).update(body).digest("hex");
  it("accepts the correct signature and rejects everything else", () => {
    expect(verifyDeviceSignature(body, good, secret)).toBe(true);
    expect(verifyDeviceSignature(body, good.toUpperCase(), secret)).toBe(true); // case-insensitive hex
    expect(verifyDeviceSignature(body, "deadbeef".repeat(8), secret)).toBe(false);
    expect(verifyDeviceSignature(Buffer.from("tampered"), good, secret)).toBe(false);
    expect(verifyDeviceSignature(body, good, "wrong-secret")).toBe(false);
    expect(verifyDeviceSignature(undefined, good, secret)).toBe(false);
    expect(verifyDeviceSignature(body, undefined, secret)).toBe(false);
  });
});

describe("isFreshTimestamp (replay guard, pure)", () => {
  const now = new Date("2026-07-12T08:00:00Z");
  it("accepts within ±10min, rejects stale/garbage", () => {
    expect(isFreshTimestamp("2026-07-12T08:05:00Z", undefined, now)).toBe(true);
    expect(isFreshTimestamp("2026-07-12T07:51:00Z", undefined, now)).toBe(true);
    expect(isFreshTimestamp("2026-07-12T07:40:00Z", undefined, now)).toBe(false);
    expect(isFreshTimestamp("nope", undefined, now)).toBe(false);
  });
});

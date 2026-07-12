// Unit: staff-attendance window/status/IP-signal helpers (pure).
import { deriveClockInStatus, hhmmToMinutes, inClockInWindow, ipMatchesAllowlist } from "../../src/hr/attendance.util";

const at = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };

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
    expect(inClockInWindow("06:00", "10:00", at(7, 30))).toBe(true);
    expect(inClockInWindow("06:00", "10:00", at(10, 0))).toBe(true);
    expect(inClockInWindow("06:00", "10:00", at(5, 59))).toBe(false);
    expect(inClockInWindow("06:00", "10:00", at(12, 0))).toBe(false);
  });
});

describe("deriveClockInStatus", () => {
  it("PRESENT up to lateAfter, LATE after", () => {
    expect(deriveClockInStatus("08:00", at(7, 59))).toBe("PRESENT");
    expect(deriveClockInStatus("08:00", at(8, 0))).toBe("PRESENT");
    expect(deriveClockInStatus("08:00", at(8, 1))).toBe("LATE");
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

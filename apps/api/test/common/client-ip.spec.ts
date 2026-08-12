// =============================================================================
// The rate limiter is only as good as "who is this from?"
// =============================================================================
// That answer was wrong in two opposite directions at once, and both were proved
// against the running stack before this was written.
//
// SPOOFABLE. The limiter read the FIRST entry of X-Forwarded-For. nginx uses
// `$proxy_add_x_forwarded_for`, which APPENDS the observed peer to whatever the
// caller sent — so the first entry is whatever the caller typed:
//
//   same IP, no header      : 401 ×10 then 429 ×5   (the limit works)
//   rotating X-Forwarded-For: 401 ×15                (15 of 15 got through)
//
// ABSENT. On the real path the browser never speaks to the API; it speaks to the
// web tier, whose proxies forwarded Authorization, x-stepup and Content-Type and
// nothing else. Every request on earth therefore reached the API from one peer:
//
//   6 password-reset requests, 6 different client IPs → 201 201 201 201 201 429
//
// The second is an availability bug before it is a security one — ten sign-in
// attempts a minute across every school, and the eleventh person anywhere is
// turned away.
// =============================================================================

import { clientIp } from "../../src/common/client-ip";

const socket = { socket: { remoteAddress: "10.1.1.9" } };

describe("clientIp", () => {
  it("takes the RIGHTMOST forwarded entry — the one a caller cannot forge", () => {
    // nginx appends what it actually saw, so the last entry is the truth and
    // everything before it is caller-supplied.
    expect(clientIp({ ...socket, headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7" } })).toBe(
      "203.0.113.7",
    );
  });

  it("ignores a spoofed prefix however long", () => {
    // The whole bypass: prepend anything, rotate it per request, and the old
    // reading gave every request its own bucket.
    expect(
      clientIp({ ...socket, headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7" } }),
    ).toBe("203.0.113.7");
  });

  it("does NOT return the leftmost entry", () => {
    // Stated as its own case because the usual advice — "the client is the
    // first entry" — is correct at the EDGE and wrong everywhere behind it,
    // which is where this runs.
    expect(clientIp({ ...socket, headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7" } })).not.toBe(
      "9.9.9.9",
    );
  });

  it("falls back to the socket peer when nothing was forwarded", () => {
    // A direct call — local development, or one service calling another.
    expect(clientIp({ ...socket, headers: {} })).toBe("10.1.1.9");
  });

  it("handles a repeated header, which arrives as an array", () => {
    expect(
      clientIp({ ...socket, headers: { "x-forwarded-for": ["9.9.9.9", "203.0.113.7"] } }),
    ).toBe("203.0.113.7");
  });

  it("tolerates whitespace and empty entries rather than keying on ''", () => {
    // A blank key would put unrelated callers in the same bucket.
    expect(clientIp({ ...socket, headers: { "x-forwarded-for": " 9.9.9.9 ,  , 203.0.113.7 " } })).toBe(
      "203.0.113.7",
    );
  });

  it("never returns empty", () => {
    expect(clientIp({ headers: {} })).toBe("unknown");
  });
});

describe("the limiter uses it", () => {
  it("keys on clientIp, not on a hand-rolled header parse", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../src/common/rate-limit.guard.ts"), "utf8");
    expect(src).toMatch(/clientIp\(req\)/);
    // The old reading must not come back.
    expect(src).not.toMatch(/split\(","\)\?\.\[0\]/);
    expect(src).not.toMatch(/xff\[0\]/);
  });
});

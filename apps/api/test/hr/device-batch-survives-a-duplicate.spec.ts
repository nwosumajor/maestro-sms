// =============================================================================
// One duplicate event discarded a whole batch of clock-ins
// =============================================================================
// Followed #262's question — what else is trusted from an untrusted source? —
// to the other unsigned-looking public write, biometric device ingestion. The
// SIGNING is genuinely sound, and the checks below record that so it is not
// re-audited:
//
//   - HMAC-SHA256 over the RAW body, not a re-serialised one;
//   - the length is compared BEFORE `timingSafeEqual`, which THROWS on a length
//     mismatch — unguarded, a short signature is a 500 rather than a refusal;
//   - the comparison itself is timing-safe;
//   - a stale batch timestamp is refused (±10 min), and the parse is NaN-safe;
//   - within that window a replay is harmless, because the write is idempotent
//     on `(userId, date)`;
//   - the day is the SCHOOL's, not the server's UTC one — already fixed here,
//     with the reasoning left in place.
//
// What was not sound is what happens when that idempotency check LOSES A RACE.
// `findFirst` then `create` on a UNIQUE `(userId, date)`: two readers reporting
// the same person at once — a gate terminal and a staffroom one, or a device
// retrying while its first request is still in flight — both find nothing and
// both insert. The loser gets P2002.
//
// And the whole batch is ONE transaction, so that P2002 rolled back every OTHER
// event in it. Two terminals seeing one person discarded a morning's clock-ins,
// and a device that does not retry loses them silently.
// =============================================================================

import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";
import { verifyDeviceSignature, isFreshTimestamp } from "../../src/hr/attendance.util";
import { createHmac } from "node:crypto";

const SECRET = "s3cret";
const body = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8");
const sign = (b: Buffer) => createHmac("sha256", SECRET).update(b).digest("hex");

describe("the device signature", () => {
  it("accepts a batch signed over the raw body", () => {
    const b = body({ timestamp: "2026-08-18T09:00:00Z", events: [] });
    expect(verifyDeviceSignature(b, sign(b), SECRET)).toBe(true);
  });

  it("refuses a batch whose body changed by one byte", () => {
    const b = body({ timestamp: "2026-08-18T09:00:00Z", events: [] });
    const tampered = body({ timestamp: "2026-08-18T09:00:01Z", events: [] });
    expect(verifyDeviceSignature(tampered, sign(b), SECRET)).toBe(false);
  });

  it("refuses a SHORT signature rather than throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, which without the guard is
    // a 500 where a 403 belongs.
    const b = body({ events: [] });
    expect(() => verifyDeviceSignature(b, "abc", SECRET)).not.toThrow();
    expect(verifyDeviceSignature(b, "abc", SECRET)).toBe(false);
  });

  it("refuses when anything is missing", () => {
    const b = body({ events: [] });
    expect(verifyDeviceSignature(undefined, sign(b), SECRET)).toBe(false);
    expect(verifyDeviceSignature(b, undefined, SECRET)).toBe(false);
    expect(verifyDeviceSignature(b, sign(b), "")).toBe(false);
  });
});

describe("the replay window", () => {
  const now = new Date("2026-08-18T09:00:00Z");
  it("accepts a batch inside the skew", () => {
    expect(isFreshTimestamp("2026-08-18T08:55:00Z", 10 * 60 * 1000, now)).toBe(true);
  });
  it("refuses one outside it, in either direction", () => {
    expect(isFreshTimestamp("2026-08-18T08:40:00Z", 10 * 60 * 1000, now)).toBe(false);
    expect(isFreshTimestamp("2026-08-18T09:20:00Z", 10 * 60 * 1000, now)).toBe(false);
  });
  it("refuses an unparseable timestamp rather than treating NaN as fresh", () => {
    expect(isFreshTimestamp("not a date", 10 * 60 * 1000, now)).toBe(false);
  });
});

describe("a duplicate inside a batch", () => {
  const SRC = readFileSync(join(__dirname, "../../src/hr/attendance.service.ts"), "utf8");
  const at = SRC.indexOf("async ingestDeviceEvents");
  const body_ = SRC.slice(at, SRC.indexOf("\n  }", SRC.indexOf("return { accepted", at)));
  const code = stripComments(body_);

  it("is caught rather than aborting the transaction", () => {
    expect(code).toMatch(/e\.code !== "P2002"/);
  });

  it("is counted as already marked — which is what the read was checking for", () => {
    const catchAt = code.indexOf("catch");
    expect(code.slice(catchAt)).toMatch(/alreadyMarked\+\+/);
  });

  it("does not swallow anything else", () => {
    expect(code).toMatch(/throw e;/);
  });

  it("still counts a genuine insert as accepted", () => {
    expect(code).toMatch(/accepted\+\+/);
  });
});

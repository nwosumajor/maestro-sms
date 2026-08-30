/**
 * "DUE BACK AT 18:00" IS A TIME AT THE SCHOOL.
 *
 * Two notices name the same instant — `hostelExeat.expectedReturnAt` — and both
 * rendered it with `toISOString().slice(0, 16)`, which is the SERVER's UTC:
 *
 *   the APPROVAL   "Expected back …", to the guardian
 *   the OVERDUE    "was due back at …", to the family AND to the staff who are
 *                  about to go looking for the child
 *
 * A pair, read twice, wrong the same way — the shape this repo has recorded
 * thirteen times, and the second time it is a TIME rather than a day. For a
 * Lagos school an 18:00 return reads 17:00; for Auckland it reads the previous
 * afternoon.
 *
 * ONE helper for both, in @sms/types beside `schoolDateString`, so a third
 * spelling cannot appear: the meeting service's private `meetingWhen` was
 * retired onto it in the same change.
 */
import { resolveRegion, schoolDateString, schoolTimeString } from "@sms/types";

const AT = new Date("2026-09-05T17:00:00.000Z");

describe("schoolTimeString", () => {
  it("reads the clock where the school is, not where the server is", () => {
    expect(schoolTimeString("Africa/Lagos", AT)).toBe("2026-09-05 18:00");
    expect(schoolTimeString("UTC", AT)).toBe("2026-09-05 17:00");
    expect(schoolTimeString("America/Toronto", AT)).toBe("2026-09-05 13:00");
  });

  it("carries the DAY across a boundary, not just the hour", () => {
    // The failure that makes this more than a cosmetic hour: east of UTC late in
    // the day, the school is already on tomorrow.
    expect(schoolTimeString("Pacific/Auckland", AT)).toBe("2026-09-06 05:00");
    expect(schoolTimeString("UTC", AT).slice(0, 10)).toBe("2026-09-05");
  });

  it("is 24-hour, so 6pm can never be read as 6am", () => {
    expect(schoolTimeString("UTC", new Date("2026-09-05T18:30:00.000Z"))).toBe("2026-09-05 18:30");
    expect(schoolTimeString("UTC", new Date("2026-09-05T06:30:00.000Z"))).toBe("2026-09-05 06:30");
  });

  it("agrees with schoolDateString about the day — one instant, one answer", () => {
    for (const tz of ["Africa/Lagos", "UTC", "America/Toronto", "Pacific/Auckland", "Asia/Singapore"]) {
      expect(schoolTimeString(tz, AT).slice(0, 10)).toBe(schoolDateString(tz, AT));
    }
  });

  it("falls back to UTC rather than losing the notice on a bad zone", () => {
    // Same fail-safe the day helper already takes: a mis-set region must not
    // stop a school being told a child is late back.
    expect(schoolTimeString("Not/AZone", AT)).toBe("2026-09-05 17:00");
  });

  it("never renders the raw ISO marker a reader would have to decode", () => {
    expect(schoolTimeString("Africa/Lagos", AT)).not.toContain("T");
    expect(schoolTimeString("Africa/Lagos", AT)).not.toContain("Z");
  });

  it("a school with no region set reads on the platform's own clock", () => {
    expect(schoolTimeString(resolveRegion({}).timezone, AT)).toBe("2026-09-05 18:00");
  });
});

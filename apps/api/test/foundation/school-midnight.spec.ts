/**
 * `schoolMidnight` — the instant a school's own clock reads 00:00 on a day.
 *
 * The inverse of `schoolDateString`, used wherever a school-local DAY bounds a
 * TIMESTAMP (a payment's `paidAt`). Cutting at UTC midnight instead put the
 * start of a Lagos month an hour late and a Toronto month four hours early.
 */
import { schoolDateString, schoolMidnight } from "@sms/types";

describe("schoolMidnight", () => {
  it.each([
    ["Africa/Lagos", "2026-10-01", "2026-09-30T23:00:00.000Z"],
    ["Asia/Singapore", "2026-10-01", "2026-09-30T16:00:00.000Z"],
    ["Asia/Kolkata", "2026-10-01", "2026-09-30T18:30:00.000Z"], // a half-hour zone
    ["America/Toronto", "2026-10-01", "2026-10-01T04:00:00.000Z"], // EDT
    ["America/Toronto", "2026-12-01", "2026-12-01T05:00:00.000Z"], // EST
    ["UTC", "2026-10-01", "2026-10-01T00:00:00.000Z"],
  ])("%s on %s starts at %s", (tz, day, instant) => {
    expect(schoolMidnight(day, tz).toISOString()).toBe(instant);
  });

  it("lands on the right side of a daylight-saving change on the day itself", () => {
    // Toronto springs forward at 02:00 on 8 March 2026 and falls back on
    // 1 November; midnight on each is still in the OLD offset.
    expect(schoolMidnight("2026-03-08", "America/Toronto").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(schoolMidnight("2026-11-01", "America/Toronto").toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });

  it("is the inverse of schoolDateString", () => {
    for (const tz of ["Africa/Lagos", "America/Toronto", "Asia/Singapore", "Pacific/Auckland"]) {
      const start = schoolMidnight("2026-07-15", tz);
      expect(schoolDateString(tz, start)).toBe("2026-07-15");
      expect(schoolDateString(tz, new Date(start.getTime() - 1))).toBe("2026-07-14");
    }
  });

  it("falls back to UTC for a zone that does not exist, rather than throwing", () => {
    expect(schoolMidnight("2026-10-01", "Not/AZone").toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

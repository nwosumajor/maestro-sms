/**
 * `/^\d{4}-\d{2}-\d{2}$/` appeared FORTY-TWO times across the API and describes
 * the SHAPE of a date rather than a date.
 *
 * MEASURED on the sharpest path, a staff member's LAST WORKING DAY:
 *
 *     2026-04-31   201  stored as 2026-05-01   <- a different MONTH
 *     2026-02-31   201  stored as 2026-03-03
 *     2026-11-31   201  stored as 2026-12-01   <- a different MONTH
 *     2026-13-45   500  Internal server error
 *     0000-01-01   201  stored as written
 *
 * The month roll is not cosmetic: `finalMonthAlreadyPaid` decides whether the
 * leaver's final month has already been paid from THE LAST WORKING DAY'S
 * MONTH, and access is revoked on that day.
 */
import { readFileSync } from "node:fs";
import { ISO_DAY_PATTERN, isIsoDay, isoDay } from "../../src/common/calendar-day";
import { walkSources } from "../support/api-routes";
import { stripComments } from "../support/strip-comments";

describe("a day that exists", () => {
  it.each(["2026-01-01", "2026-02-28", "2024-02-29", "2026-12-31", "1900-01-01", "2200-12-31"])(
    "accepts %s", (v) => {
      expect(isoDay.parse(v)).toBe(v);
    },
  );

  // THE ROLL IS THE POINT. JavaScript turns 31 April into 1 May rather than
  // refusing it, so a shape check and a NaN check both pass and the record
  // silently holds a different month.
  it.each(["2026-04-31", "2026-06-31", "2026-09-31", "2026-11-31", "2026-02-31", "2026-02-29"])(
    "refuses %s, which JavaScript would roll forward", (v) => {
      expect(isIsoDay(v)).toBe(false);
      expect(() => isoDay.parse(v)).toThrow();
      // and prove the roll is real, so this test cannot pass vacuously
      const rolled = new Date(`${v}T00:00:00.000Z`);
      expect(Number.isNaN(rolled.getTime()) || rolled.toISOString().slice(0, 10) !== v).toBe(true);
    },
  );

  it.each(["2026-13-45", "2026-00-10", "2026-1-1", "20260101", "", "abc"])("refuses %s", (v) => {
    expect(isIsoDay(v)).toBe(false);
  });

  // `0000-01-01` is what a broken form default looks like, not a date anybody
  // chose. A sanity bound, deliberately generous.
  it.each(["0000-01-01", "1899-12-31", "2201-01-01"])("refuses the out-of-range year %s", (v) => {
    expect(isIsoDay(v)).toBe(false);
  });

  it("has one pattern", () => {
    expect(ISO_DAY_PATTERN.source).toBe("^\\d{4}-\\d{2}-\\d{2}$");
  });
});

describe("nobody hand-rolls a forty-third", () => {
  it("no schema or service builds its own YYYY-MM-DD check", () => {
    const files = walkSources();
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const path of files) {
      if (path.endsWith("common/calendar-day.ts")) continue;
      // The window narrower legitimately names the shape to tell a DATE from a
      // TIMESTAMP; what it must not do is decide validity from the shape, which
      // is asserted separately below.
      if (path.endsWith("common/status-filter.ts")) continue;
      const src = stripComments(readFileSync(path, "utf8"));
      for (const m of src.matchAll(/\\d\{4\}-\\d\{2\}-\\d\{2\}/g)) offenders.push(`${path}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  // A LIST FILTER IS THE SAME QUESTION. `dateFilter` caught `2026-13-45` (an
  // Invalid Date) and not `2026-04-31` (which rolls), so a finance window could
  // silently begin in the wrong month.
  it("the query-string window checks the day exists, not only that it parses", () => {
    const src = readFileSync(
      walkSources().find((p) => p.endsWith("common/status-filter.ts"))!,
      "utf8",
    );
    expect(src).toMatch(/isIsoDay\(v\.slice\(0, 10\)\)/);
    expect(src).toMatch(/from "\.\/calendar-day"/);
  });

  // The modules whose dates DECIDE something reach for the shared one. An empty
  // offender list above also passes for code that stopped validating at all.
  it.each([
    "src/hr/exit.controller.ts",
    "src/hr/exit.service.ts",
    "src/hr/leave.controller.ts",
    "src/hr/salary.controller.ts",
    "src/hr/duty.service.ts",
    "src/hr/staff-lifecycle.controller.ts",
    "src/attendance/attendance.controller.ts",
    "src/fees/fees.controller.ts",
  ])("%s uses the shared validator", (p) => {
    const path = walkSources().find((x) => x.endsWith(p));
    expect(path).toBeDefined();
    expect(readFileSync(path!, "utf8")).toMatch(/from "[./]*common\/calendar-day"/);
  });
});

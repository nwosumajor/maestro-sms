// =============================================================================
// A register for a day that has not happened
// =============================================================================
// There was a guard for the PAST — a term that has ended is read-only — and
// none at all for the future. `daysSince` goes NEGATIVE for a future date, so
// such a register was not even "stale" and went straight through. Measured
// live: marking a pupil ABSENT on 2026-09-10, 2027-06-01 and 2030-01-15 all
// answered 201.
//
// Two costs. An ABSENT or LATE mark notifies the guardians, so a family could
// be told their child missed a day that has not come; and attendance feeds the
// rate printed on the report card, where a future absence is a wrong figure
// about a child.
//
// It also protects the partitioning added alongside: `attendance_record` is
// RANGE-partitioned by month with partitions provisioned three months ahead, so
// a mistyped year lands in the DEFAULT partition — TWO OF THOSE THREE DID — and
// those rows have to be migrated out by hand before a real partition can ever
// be created for their month.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "..", "..", "src", "attendance", "attendance.service.ts"), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const body = strip(src);

describe("marking a register", () => {
  it("refuses a date in the future", () => {
    expect(body).toMatch(/if \(this\.daysSince\(date, schoolNow\) < 0\)/);
    expect(body).toMatch(/A register cannot be taken for a date in the future/);
  });

  it("measures it against the SCHOOL's day, not the server's", () => {
    // A register taken on a Singapore morning is not tomorrow. `schoolNow` is
    // already the school's day; the check must use it rather than `new Date()`.
    const at = body.indexOf("daysSince(date, schoolNow) < 0");
    expect(at).toBeGreaterThan(-1);
    const before = body.slice(0, at);
    expect(before).toMatch(/const schoolNow = schoolToday\(/);
  });

  it("checks BEFORE the staleness branch, so a future date cannot become an amendment", () => {
    // Otherwise a future register would be routed into maker-checker or applied
    // directly depending on a negative day count, which is meaningless either
    // way.
    expect(body.indexOf("daysSince(date, schoolNow) < 0")).toBeLessThan(
      body.indexOf("> STALE_REGISTER_DAYS"),
    );
  });

  it("still allows TODAY, which is the ordinary case", () => {
    // A strict `< 0` and not `<= 0`: the whole product is built around taking
    // today's register.
    expect(body).not.toMatch(/daysSince\(date, schoolNow\) <= 0/);
  });

  it("keeps the PAST guard it already had", () => {
    expect(body).toMatch(/Past-term registers are read-only/);
  });
});

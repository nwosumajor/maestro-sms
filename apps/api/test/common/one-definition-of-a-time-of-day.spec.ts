/**
 * Six schemas across four modules each wrote their own "HH:MM" and they did not
 * agree: the timetable and the exam planner required a real 24-hour clock while
 * transport and every HR field accepted `\d{1,2}:\d{2}` — which takes `25:99`.
 *
 * MEASURED on the running stack, on the field that decides whether a member of
 * staff is marked late:
 *
 *     lateAfter "99:99"  stored, 200        the same clock-in -> PRESENT
 *     lateAfter "06:00"  the real setting   the same clock-in -> LATE
 *
 * A typo in that box switches lateness recording off for the whole school,
 * silently and permanently.
 */
import { HHMM_PATTERN, hhmm, isHhmm, normaliseHhmm } from "../../src/common/time-of-day";
import { readFileSync } from "node:fs";
import { walkSources } from "../support/api-routes";
import { stripComments } from "../support/strip-comments";

describe("one definition of a time of day", () => {
  it.each(["00:00", "09:30", "23:59", "12:05"])("accepts %s", (v) => {
    expect(hhmm.parse(v)).toBe(v);
  });

  // The values that were being stored.
  it.each(["25:99", "99:99", "8:60", "24:00", "23:60", "", "0830", "8:3", "abc"])(
    "refuses %s", (v) => {
      expect(() => hhmm.parse(v)).toThrow();
      expect(isHhmm(v)).toBe(false);
    },
  );

  // A person typing into a free-text box is not making a mistake, and the
  // stricter rule must not refuse them.
  it("normalises a single-digit hour rather than refusing it", () => {
    expect(hhmm.parse("9:30")).toBe("09:30");
    expect(hhmm.parse(" 9:05 ")).toBe("09:05");
    expect(normaliseHhmm("7:00")).toBe("07:00");
  });

  // ZERO-PADDED IS LOAD-BEARING: the trip list is `orderBy: { departTime:
  // "asc" }` in SQL, so "9:30" would sort after "15:45".
  it("stores a form that sorts correctly as a string", () => {
    const times = ["15:45", "9:30", "7:05"].map((t) => hhmm.parse(t));
    expect([...times].sort()).toEqual(["07:05", "09:30", "15:45"]);
  });

  it("has one pattern, and it is the strict one", () => {
    expect(HHMM_PATTERN.source).toBe("^([01]\\d|2[0-3]):[0-5]\\d$");
  });
});

describe("nobody hand-rolls a seventh", () => {
  // A control written six times is right five times. This is what stops the
  // seventh copy, and it is the same rule the CSV formula guard needed.
  it("no schema or service builds its own HH:MM check", () => {
    const files = walkSources();
    // A walk that finds nothing produces no offenders and passes covering
    // nothing.
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const path of files) {
      if (path.endsWith("common/time-of-day.ts")) continue;
      // `hhmmToMinutes` is a READER of an already-validated value and is
      // deliberately tolerant; it is not a boundary check.
      const src = stripComments(readFileSync(path, "utf8"))
        .replace(/export function hhmmToMinutes[\s\S]*?\n}/, "");
      for (const m of src.matchAll(/\/\^[^/\n]*\\d\{1,2\}\)?:[^/\n]*\/|\/\^[^/\n]*\\d\{2\}\):?\[0-5\][^/\n]*\/|\/\^\\d\{2\}:\\d\{2\}\$\//g)) {
        offenders.push(`${path}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Every module that takes a time of day reaches for the shared one — an empty
  // offender list also passes for code that stopped validating at all.
  it.each([
    "src/transport/transport.controller.ts",
    "src/timetable/timetable.controller.ts",
    "src/exam/exam.controller.ts",
    "src/hr/duty.controller.ts",
    "src/hr/attendance.controller.ts",
    "src/transport/transport.service.ts",
    "src/hr/attendance.service.ts",
  ])("%s uses the shared validator", (p) => {
    const path = walkSources().find((x) => x.endsWith(p));
    expect(path).toBeDefined();
    expect(readFileSync(path!, "utf8")).toMatch(/from "\.\.\/common\/time-of-day"/);
  });
});

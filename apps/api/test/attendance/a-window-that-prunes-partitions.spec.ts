/**
 * A windowed read of the register must filter on the RECORD's own date.
 *
 * `attendance_record` is RANGE-partitioned by month on a DENORMALISED `date`,
 * and that column exists for exactly one reason, stated in its own schema
 * comment: Postgres can only partition on a column of the table itself, and the
 * school day lived only on `attendance_session`. Filtering through the joined
 * session cannot prune — Postgres must scan every partition and join to find out
 * which rows fall in the window — so the cost tracks the school's AGE rather
 * than the size of the window being asked for.
 *
 * The migration denormalised the column and moved SOME readers. Eight windowed
 * reads were still going through the session: both halves of the nightly
 * rollup, the report card's attendance block, the analytics attendance figure,
 * a pupil's own summary, the by-class board and two group-console aggregates.
 *
 * Measured as the application role with RLS in force, one term of a school with
 * 173,701 records:
 *
 *     via s.date   10 partitions seq-scanned, 173,701 rows, 2,851 buffers, 63.9 ms
 *     via r.date    4 partitions,                            planning 16.6 -> 1.1 ms
 *
 * Equivalent by construction: the date is copied from the session and never
 * changes for a given session. Verified across all 173,701 rows — zero
 * mismatches, and the aggregates identical either way.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../../src");

function sources(): string[] {
  const out: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  })(SRC);
  return out;
}

/** Comments stripped: this repo has twice had a gate fire on prose about SQL. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/^\s*--.*$/gm, "");

describe("a window that prunes partitions", () => {
  const files = sources();

  it("scanned a believable number of sources", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("no Prisma read of the register filters through session.date", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = strip(readFileSync(f, "utf8"));
      if (!/attendanceRecord\./.test(src)) continue;
      // `session: { date: ... }` inside a where — the shape that cannot prune.
      for (const m of src.matchAll(/session:\s*\{\s*date:/g)) {
        const line = src.slice(0, m.index).split("\n").length;
        bad.push(`${f.replace(SRC + "/", "")}:${line} filters through session.date`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("no raw query windows attendance_record on the session's date", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = strip(readFileSync(f, "utf8"));
      if (!/attendance_record/.test(src)) continue;
      // `s.date` used as a bound against attendance_record's window.
      for (const m of src.matchAll(/\bs\.date\s*(?:BETWEEN|>=|<=|>|<)/gi)) {
        const line = src.slice(0, m.index).split("\n").length;
        bad.push(`${f.replace(SRC + "/", "")}:${line} bounds on s.date, which cannot prune`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the readers that were moved still window on something", () => {
    // Magnitude: both rules above pass trivially against code that stopped
    // filtering by date at all, which would be a correctness bug, not a fix.
    const rollup = readFileSync(join(SRC, "attendance/attendance-rollup.service.ts"), "utf8");
    expect(rollup.match(/r\.date BETWEEN/g)?.length).toBe(2);
    const card = readFileSync(join(SRC, "reportcards/reportcard.service.ts"), "utf8");
    expect(card).toMatch(/date: \{ gte: term\.startDate, lte: term\.endDate \}/);
  });
});

// =============================================================================
// One definition of an attendance rate
// =============================================================================
// There were SIX, in two camps, and nothing said so:
//
//   present + late            report card, analytics page, parent dashboard
//   present + late + EXCUSED  class board, student summary, attendance rollup
//
// So a pupil with authorised absences had two attendance percentages depending
// on which screen you opened. Measured on a real pupil over one term — 54
// present, 9 late, 2 absent, 5 excused of 70 — the report card printed 90% and
// the student summary computed 97%.
//
// // GOTCHA, TWICE: the divergence was written into comments claiming the
// opposite. `getStudentSummary` said "LATE counts as attending … would
// contradict the report card" on the line that also added `excused`; the rollup
// said "LATE and EXCUSED count as attending … contradict the report card, WHICH
// USES THE SAME RULE". The card has never used that rule. A comment asserting
// agreement is not agreement.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";
import { attendanceRatePct, attendanceTotal } from "@sms/types";

const SRC = join(__dirname, "..", "..", "src");
const strip = (s: string) => s.replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    out = statSync(p).isDirectory() ? out.concat(walk(p)) : p.endsWith(".ts") ? out.concat(p) : out;
  }
  return out;
}

describe("the rule", () => {
  const term = { present: 54, late: 9, absent: 2, excused: 5 };

  it("counts LATE as attending — the pupil was in school", () => {
    expect(attendanceRatePct({ present: 10, late: 0, absent: 0, excused: 0 })).toBe(100);
    expect(attendanceRatePct({ present: 9, late: 1, absent: 0, excused: 0 })).toBe(100);
  });

  it("does NOT count EXCUSED — the pupil was absent, the reason was accepted", () => {
    expect(attendanceRatePct(term)).toBe(90);
    // The figure the three internal screens used to give for the same pupil.
    expect(attendanceRatePct(term)).not.toBe(97);
  });

  it("keeps EXCUSED in the denominator — an authorised absence is still a school day", () => {
    expect(attendanceTotal(term)).toBe(70);
  });

  it("is NULL when no register was taken, never zero", () => {
    // "No register yet" and "attended nothing" are different facts about a
    // child, and reporting the first as the second is the mistake the report
    // card's own attendance block documents.
    expect(attendanceRatePct({ present: 0, late: 0, absent: 0, excused: 0 })).toBeNull();
  });
});

describe("every surface that prints a rate", () => {
  it("uses the shared definition", () => {
    for (const rel of [
      "attendance/attendance.service.ts",
      "attendance/attendance-rollup.service.ts",
      "analytics/analytics.service.ts",
      "reportcards/reportcard.service.ts",
    ]) {
      expect(strip(stripComments(readFileSync(join(SRC, rel), "utf8")))).toContain("attendanceRatePct(");
    }
  });

  it("leaves NO hand-rolled formula that adds excused", () => {
    // The whole defect in one pattern. A seventh screen adding `excused` back
    // would give a child a different attendance rate from their own report card.
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const src = strip(stripComments(readFileSync(f, "utf8")));
      if (/present\s*\+\s*late\s*\+\s*excused|PRESENT\s*\+\s*[\w.]*LATE\s*\+\s*[\w.]*EXCUSED/i.test(src)) {
        offenders.push(f.split("/src/")[1]);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scanned a believable number of files", () => {
    expect(walk(SRC).length).toBeGreaterThan(200);
  });
});

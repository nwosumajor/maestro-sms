// =============================================================================
// A campus flagged on the group overview showed NO flags on its own page
// =============================================================================
// The overview computes each campus's flags over the DIRECTOR'S SELECTED PERIOD.
// The drill-down computed them from `trend.at(-1)` — the CURRENT CALENDAR MONTH
// — and from a six-month count of attendance RECORDS where the overview counts
// SESSIONS. Two different questions wearing one name.
//
// Measured on a campus at 63% over ninety days:
//
//   overview  period=term   att 63 · regs 20 · flags LOW_ATTENDANCE
//   drill-down (no period)  att —  · regs —  · flags (none)
//
// The flag vanished exactly where a director goes to find out why.
//
// WORSE THAN A MISMATCH, and why this is not an edge case: the current calendar
// month is EMPTY on the 1st, so `attendancePct` was null and LOW_ATTENDANCE
// could not fire on any campus page for the first days of every month. A
// partial period read as a fact.
//
// The drill-down takes the same `period` now and asks the same two questions, so
// the two agree by construction rather than by coincidence.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";

const SRC = join(__dirname, "../../src/group");
const service = stripComments(readFileSync(join(SRC, "group.service.ts"), "utf8"));
const controller = stripComments(readFileSync(join(SRC, "group.controller.ts"), "utf8"));

/** The body of one method, so an assertion cannot be satisfied by the other. */
function methodBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at === -1) return "";
  let i = src.indexOf("(", at);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  let angle = 0;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "<") angle += 1;
    else if (ch === ">") angle -= 1;
    else if (ch === "{" && angle === 0) break;
  }
  const start = i;
  depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

describe("the campus page agrees with the list it was clicked from", () => {
  const detail = methodBody(service, "async schoolDetail(");

  it("found the sources it is about", () => {
    expect(service.length).toBeGreaterThan(8000);
    expect(detail.length).toBeGreaterThan(2000);
    expect(controller.length).toBeGreaterThan(1000);
  });

  it("takes the same period the overview took", () => {
    expect(controller).toMatch(/@Query\("period"\)/);
    expect(controller).toMatch(/schoolDetail\(p, schoolId, \{ period \}\)/);
    expect(detail).toMatch(/this\.resolvePeriod\(opts\.period\)/);
  });

  it("computes its flags over that period, not over the last month of the trend", () => {
    // Anchored to WHERE THE NUMBER COMES FROM, not to how the old line was
    // spelled: `not.toMatch(/latest\?\.attendancePct/)` named one variable and
    // let a mutation using `trend.at(-1)?.attendancePct` straight through.
    expect(detail).toMatch(/attendancePct: attTotal > 0/);
    expect(detail).not.toMatch(/attendancePct:\s*(trend|latest)/);
    expect(detail).toMatch(/period\.from/);
    expect(detail).toMatch(/period\.to/);
  });

  it("counts SESSIONS taken, the way the overview does", () => {
    // It summed attendance RECORDS across six months, so a campus that had
    // stopped taking the register still looked as though it had.
    expect(detail).toMatch(/attendanceSession\.count/);
    expect(detail).not.toMatch(/monthlyAtt\.reduce/);
  });

  it("shows the figures the flags were computed from", () => {
    // A LOW_ATTENDANCE flag with no percentage tells a director a campus needs
    // attention and gives them nothing to judge it by.
    expect(detail).toMatch(/attendancePct: base\.attendancePct/);
    expect(detail).toMatch(/registersTaken: base\.registersTaken/);
  });

  it("still keeps the six-month trend, which is its own question", () => {
    expect(detail).toMatch(/trend/);
    expect(detail).toMatch(/trendCurrency/);
  });
});

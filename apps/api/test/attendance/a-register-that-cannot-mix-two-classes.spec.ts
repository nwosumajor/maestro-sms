// =============================================================================
// A register takes the CLASS's pupils, never the teacher's
// =============================================================================
// A teacher is attached to a class two ways, and only one of them is a register.
// Akinlabi Alex is the FORM TEACHER of SS1 Science A — its register is his, and
// his name is against where those children were — and he also teaches
// Mathematics to SS1 Science B and SS2 Art A, where he marks nobody.
//
// The risk this pins is the roster QUIETLY WIDENING to "pupils this teacher
// teaches". It would look right — four names, all his pupils — and it would put
// children in a legal record of a room they were never in, under the name of a
// teacher who never saw them there. Nothing about the screen would say so.
//
// It has never been possible: `canTakeRegister` gates BOTH the offered list and
// the write, and the roster is read per CLASS. This drives that rather than
// restating it, because the property is worth more than the current
// implementation of it.
// =============================================================================

import { canTakeRegister } from "../../src/attendance/attendance.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const AKINLABI = "u-akinlabi";

/** His school, as it really is: one class he is responsible for, three he teaches. */
const SCIENCE_A = { id: "c-sci-a", name: "SS1 Science A", supervisorId: AKINLABI };
const SCIENCE_B = { id: "c-sci-b", name: "SS1 Science B", supervisorId: "u-anakin" };
const ART_A = { id: "c-art-a", name: "SS2 Art A", supervisorId: "u-conner" };
const TAUGHT = [SCIENCE_A, SCIENCE_B, ART_A];

const teacher: Principal = {
  schoolId: "S",
  userId: AKINLABI,
  roles: ["teacher"],
  permissions: ["attendance.read", "attendance.write"],
};

describe("which classes a subject teacher may mark", () => {
  it("exactly the one he is FORM TEACHER of, out of the three he teaches", () => {
    const takeable = TAUGHT.filter((c) => canTakeRegister(teacher, c.supervisorId));
    expect(takeable.map((c) => c.name)).toEqual(["SS1 Science A"]);
  });

  it("teaching a subject to a class grants NOTHING over its register", () => {
    // The distinction the whole page turns on. He teaches Mathematics in all
    // three; he is responsible for one room.
    expect(canTakeRegister(teacher, SCIENCE_B.supervisorId)).toBe(false);
    expect(canTakeRegister(teacher, ART_A.supervisorId)).toBe(false);
  });

  it("is decided by RESPONSIBILITY, not by seniority or by subject", () => {
    // Same person, same subjects: the only thing that moves the answer is whose
    // name is on the class.
    expect(canTakeRegister(teacher, AKINLABI)).toBe(true);
    expect(canTakeRegister({ ...teacher, roles: ["principal"] }, SCIENCE_B.supervisorId)).toBe(false);
  });
});

describe("the page cannot offer what the API would refuse", () => {
  it("the offered list and the write gate are the SAME function", () => {
    // Written twice, they drift, and the drift shows up as a form that fails on
    // save — which this codebase has already met once on this very page. The
    // board's `canTake`, the page's takeable list and `assertCanTakeRegister`
    // all call this.
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../src/attendance/attendance.service.ts"),
      "utf8",
    );
    // Every decision point CALLS the one exported rule. One definition and
    // three callers: the write gate and the two boards' `canTake`.
    const definition = src.match(/export function canTakeRegister\(/g) ?? [];
    const callers = (src.match(/[^n] canTakeRegister\(|= canTakeRegister\(|canTake: canTakeRegister\(|if \(canTakeRegister\(/g) ?? []);
    expect(definition).toHaveLength(1);
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  it("reports school-wide sight separately from the right to mark", () => {
    // `schoolWide` shapes the page; `canTake` decides each row. Conflating them
    // is how a teacher ends up looking at three classes' worth of pupils on the
    // page where they mark one.
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../src/attendance/attendance.service.ts"),
      "utf8",
    );
    // EVERY site that reports it must COMPUTE it. Asserting the string appears
    // somewhere passed a mutation that hard-coded `true` on the main return,
    // because the early-return path still carried the real call — the
    // "matched by accident" failure this repo keeps meeting. Count both sides.
    const reported = src.match(/schoolWide:/g) ?? [];
    const computed = src.match(/schoolWide: this\.isSchoolWide\(p\)/g) ?? [];
    expect(reported.length).toBeGreaterThanOrEqual(2); // the empty-class path and the full one
    expect(computed).toHaveLength(reported.length);
  });
});

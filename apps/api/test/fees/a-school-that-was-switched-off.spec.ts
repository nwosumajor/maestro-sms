// =============================================================================
// Still charging the parents of a school that had been switched off
// =============================================================================
// DISABLED is the operator's hard lever, and auth says exactly what it means:
// it "blocks ALL of its members' logins", deliberately unlike PAST_DUE, which
// only degrades modules so a school can still reach /billing and pay.
//
// Two nightly sweeps did not know. Both selected `{ isPlatform: false }` with no
// status filter:
//
//   lateFeeSweep      adds a late-fee line item to every overdue invoice
//   reminderSweep     emails and texts the guardians about the balance
//
// So a school the operator had switched off went on billing its parents every
// night and messaging them in the school's name — while nobody at that school
// could sign in to see it, stop it, or answer a parent who rang about it. If the
// school was disabled for non-payment that is charging its families for a
// service they cannot reach; if it was disabled for a closure or a breach, it is
// worse.
//
// The rest of the fleet sweeps are deliberately NOT changed: retention must keep
// purging a disabled school's data because the obligation does not stop, and the
// attendance rollup and term progression touch nothing but internal state that
// has to be right if the school is ever switched back on. This is about the two
// that reach people and money.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/fees/fee-ops.service.ts"), "utf8");

/** The `school.findMany({...})` call inside the named method. */
function schoolQuery(method: string): string {
  const from = SRC.indexOf(`async ${method}(`);
  expect([method, from]).not.toEqual([method, -1]);
  const at = SRC.indexOf("school.findMany(", from);
  expect([method, at]).not.toEqual([method, -1]);
  return SRC.slice(at, at + 260);
}

describe("a school the operator switched off", () => {
  it("is not charged a late fee", () => {
    expect(schoolQuery("lateFeeSweep")).toMatch(/status: "ACTIVE"/);
  });

  it("does not have its guardians reminded about money", () => {
    expect(schoolQuery("reminderSweep")).toMatch(/status: "ACTIVE"/);
  });

  it("is still excluded from the platform's own org, as before", () => {
    // The existing filter must survive: the platform org has no pupils and no
    // invoices, and sweeping it would be meaningless work either way.
    for (const m of ["lateFeeSweep", "reminderSweep"]) {
      expect([m, /isPlatform: false/.test(schoolQuery(m))]).toEqual([m, true]);
    }
  });
});

describe("what is deliberately left alone", () => {
  it("retention still purges a disabled school", () => {
    // The obligation to delete minors' telemetry on time does not pause because
    // a school stopped paying, and nothing about the purge reaches a person.
    const retention = readFileSync(
      join(__dirname, "../../src/integrity/retention/integrity-retention.service.ts"),
      "utf8",
    );
    const at = retention.indexOf("school.findMany(");
    expect(retention.slice(at, at + 200)).not.toMatch(/status: "ACTIVE"/);
  });

  it("the rollup and the term roll-over still run, since they only move internal state", () => {
    for (const f of [
      "../../src/attendance/attendance-rollup.service.ts",
      "../../src/lms/progression/academic-progression.service.ts",
    ]) {
      const src = readFileSync(join(__dirname, f), "utf8");
      const at = src.indexOf("school.findMany(");
      expect([f, /status: "ACTIVE"/.test(src.slice(at, at + 200))]).toEqual([f, false]);
    }
  });
});

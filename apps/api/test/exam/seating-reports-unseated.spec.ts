// =============================================================================
// Twenty-five children with no seat, and a screen that said it was done
// =============================================================================
// "Seat all" fills every unseated sitting in a schedule from its class roster.
// A hall smaller than its class is filled to capacity and the rest of the roll
// is dropped:
//
//     if (s.capacity > 0) studentIds = studentIds.slice(0, s.capacity);
//     ...
//     seatedCount += 1;
//
// The sitting still counts as seated, and the answer counted SITTINGS. Verified
// live — a class of 30 in a hall of 5:
//
//     seat all -> 201 {"seated":1,"skipped":0}
//     seats actually created: 5
//
// `skipped: 0` positively asserts that nothing was left out, and the screen then
// said "Seated every unseated sitting in this schedule." Twenty-five children
// would have discovered otherwise in the corridor on exam morning.
//
// Partial seating is kept — filling one hall and opening another is ordinary
// practice — but the shortfall is now named per hall, and the other reasons a
// sitting is passed over are separated: already seated (benign, and what makes
// re-running safe), no class attached (can never seat), empty class.
//
// The approval path auto-seats unattended, with nobody watching a screen at all,
// so the shortfall goes onto its audit row too.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/exam/exam.service.ts"), "utf8");
const PLANNER = readFileSync(join(__dirname, "../../../web/components/exam/ExamPlanner.tsx"), "utf8");
const seater = SRC.slice(SRC.indexOf("private async autoSeatSchedule("), SRC.indexOf("async seatClass("));

describe("the seater counts pupils, not just sittings", () => {
  it("records the shortfall when a hall is smaller than its class", () => {
    expect(seater).toMatch(/if \(s\.capacity > 0 && roll\.length > s\.capacity\)/);
    expect(seater).toMatch(/overflow\.push\(\{ sittingId: s\.id, capacity: s\.capacity, classSize: roll\.length, unseated: roll\.length - s\.capacity \}\)/);
  });

  it("counts the pupils it actually seated", () => {
    expect(seater).toMatch(/seatedStudents \+= studentIds\.length;/);
  });

  it("still seats the ones who fit, rather than refusing the hall", () => {
    // Refusing would be its own failure: an officer legitimately fills one hall
    // and opens another.
    expect(seater).toMatch(/studentIds = roll\.slice\(0, s\.capacity\)/);
    expect(seater).toMatch(/examSeat\.createMany/);
  });

  it("separates the reasons a sitting was passed over", () => {
    expect(seater).toMatch(/reasons\.alreadySeated \+= 1;/);
    expect(seater).toMatch(/reasons\.noClass \+= 1;/);
    expect(seater).toMatch(/reasons\.emptyClass \+= 1;/);
  });

  it("still leaves an already-seated sitting untouched", () => {
    // What makes the button safe to press twice: seat numbers pupils were told
    // are never renumbered.
    const block = seater.slice(seater.indexOf("if (hasSeats.has(s.id))"), seater.indexOf("const classId = classOf(s);"));
    expect(block).toMatch(/continue;/);
    expect(block).not.toMatch(/createMany/);
  });
});

describe("what the endpoint answers", () => {
  const fn = SRC.slice(SRC.indexOf("async seatSchedule("), SRC.indexOf("async seatClass("));

  it("returns the pupils seated and the pupils left without a seat", () => {
    expect(fn).toMatch(/seatedStudents: outcome\.seatedStudents/);
    expect(fn).toMatch(/const unseatedStudents = outcome\.overflow\.reduce/);
  });

  it("names the halls that came up short", () => {
    // A number alone does not tell an officer which hall to fix.
    expect(fn).toMatch(/title: nameOf\.get\(o\.sittingId\)\?\.title/);
    expect(fn).toMatch(/hall: nameOf\.get\(o\.sittingId\)\?\.hall/);
  });

  it("audits the shortfall", () => {
    expect(fn).toMatch(/metadata: \{ seated, total, seatedStudents: outcome\.seatedStudents, unseatedStudents, reasons: outcome\.reasons \}/);
  });

  it("keeps the original seated/skipped counts, so nothing that read them breaks", () => {
    expect(fn).toMatch(/skipped: total - seated,/);
  });
});

describe("the approval path, which seats with nobody watching", () => {
  it("puts the shortfall on its audit row", () => {
    const approval = SRC.slice(0, SRC.indexOf("private async autoSeatSchedule("));
    expect(approval).toMatch(/autoUnseated = outcome\.overflow\.reduce/);
    expect(approval).toMatch(/metadata: \{ requestId: req\.id, exams: examIds\.length, autoSeated, autoUnseated \}/);
  });
});

describe("the screen reports it", () => {
  it("no longer announces a fixed success string", () => {
    expect(PLANNER).not.toMatch(/,\s*"Seated every unseated sitting in this schedule\."/);
  });

  it("says how many candidates were seated, not how many sittings", () => {
    expect(PLANNER).toMatch(/Seated \$\{d\.seatedStudents\} candidate/);
  });

  it("says loudly when children have no seat, and which hall", () => {
    expect(PLANNER).toMatch(/NO seat/);
    expect(PLANNER).toMatch(/holds \$\{o\.capacity\} of \$\{o\.classSize\}/);
    expect(PLANNER).toMatch(/Open another hall or raise the capacity/);
  });

  it("flags a sitting with no class, which can never seat", () => {
    expect(PLANNER).toMatch(/no class attached/);
  });
});

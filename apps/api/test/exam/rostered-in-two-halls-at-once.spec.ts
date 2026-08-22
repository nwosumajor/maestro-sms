// =============================================================================
// Rostered into two halls at nine o'clock
// =============================================================================
// `assertNoInvigilatorClash` reads what the person is already down for, decides
// the overlap in Node, and then the caller inserts. Between the read and the
// insert there is nothing. Two requests that arrive together both see a clear
// diary and both succeed.
//
// Proved live against the running stack — one member of staff, two sittings in
// the same 09:00–11:00 window on the same day, in different halls:
//
//   sequential   201 then 409   (the check works)
//   concurrent   201 and 201    → rostered in TWO halls at 09:00
//
// That is the exact failure the check exists to prevent, and the service says so
// itself: "the failure surfaces on exam morning with one of the two halls simply
// unattended". The cover list had the same shape, with the same consequence — a
// teacher expected in two rooms.
//
// WHY A LOCK AND NOT A CONSTRAINT. The other races here were closed with a
// unique key or an atomic claim: the library decrements availableCopies with a
// predicate, hostel allocation row-locks the room. Those work when the thing
// being claimed is ONE ROW. A clash is not — it is "does any row overlap this
// window", across two tables for cover and an interval comparison for exams. No
// unique index expresses it. So the transaction locks THE PERSON, which is
// exactly the tool `TermResultService` already uses for the shared result row.
//
// After the fix, the same concurrent pair: 201 and 409, in either order, and one
// hall.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXAM_SRC = readFileSync(join(__dirname, "../../src/exam/exam.service.ts"), "utf8");
const COVER_SRC = readFileSync(join(__dirname, "../../src/timetable/lesson-cover.service.ts"), "utf8");
const LOCK_SRC = readFileSync(join(__dirname, "../../src/common/person-lock.ts"), "utf8");

describe("the lock that makes the clash check mean something", () => {
  it("is taken BEFORE the invigilator clash is read", () => {
    // Taken after the read, it is worthless: the diary this decision rests on
    // was read while somebody else could still be writing to it.
    const body = EXAM_SRC.slice(EXAM_SRC.indexOf("async assignInvigilator("), EXAM_SRC.indexOf("async getInvigilators("));
    const lockAt = body.indexOf("lockPerson(");
    const checkAt = body.indexOf("assertNoInvigilatorClash(");
    expect(lockAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(checkAt);
  });

  it("is taken BEFORE the cover double-booking is read", () => {
    const body = COVER_SRC.slice(COVER_SRC.indexOf("async assignCover("), COVER_SRC.indexOf("async removeCover("));
    const lockAt = body.indexOf("lockPerson(");
    const clashAt = body.indexOf("timetableEntry.findFirst({\n        where: { teacherId:");
    expect(lockAt).toBeGreaterThan(-1);
    expect(body.indexOf("clashOwn")).toBeGreaterThan(lockAt);
    if (clashAt > -1) expect(lockAt).toBeLessThan(clashAt);
  });

  it("keys on the PERSON, within their school", () => {
    // Cluster-wide namespace: without the tenant in the key one school's
    // rostering would block another's. Per-person rather than per-school
    // because seating a hall is a burst of these.
    expect(LOCK_SRC).toMatch(/pg_advisory_xact_lock\(hashtext\(/);
    expect(LOCK_SRC).toMatch(/\$\{schoolId\}:\$\{personId\}/);
  });

  it("is transaction-scoped, so nothing is left held by a request that threw", () => {
    expect(LOCK_SRC).toMatch(/pg_advisory_xact_lock/);
    expect(LOCK_SRC).not.toMatch(/pg_advisory_lock\(/);
    expect(LOCK_SRC).not.toMatch(/pg_advisory_unlock/);
  });
});

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

// ---------------------------------------------------------------------------

import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { asDuplicate } from "../../src/common/unique-violation";

// The same race, in a shape an INDEX can express — and four places where the
// rule was code-only:
//
//   hostel_allocation          "Student already has an active hostel allocation"
//   transport_assignment       "Passenger already has an active transport assignment"
//   staff_exit                 "An exit for this employee is already awaiting a decision"
//   employment_change_request  "An identical request is already awaiting a decision"
//
// A boarder in two beds, a passenger on two routes, and on the two maker-checker
// paths two settlements or two pay changes awaiting approval for one person —
// either of which is money.
//
// A partial unique index, NOT a lock: "one row per person among those in the
// active state" is exactly an index, unlike "does any row overlap this window".
// Declarative, binding on every writer for ever, free at read time.

describe("the constraint behind the sentence", () => {
  const P2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the (not available)", {
    code: "P2002",
    clientVersion: "5.22.0",
    // meta.target DELIBERATELY absent: this deployment does not send one, and a
    // translator that keys off the column list silently never fires. A fixture
    // that supplied one would make this test pass against code that cannot work.
  });

  it("turns a unique violation into the guard's own words", async () => {
    await expect(asDuplicate("Student already has an active hostel allocation", async () => {
      throw P2002;
    })).rejects.toThrow("Student already has an active hostel allocation");
  });

  it("answers the loser of a race exactly as it answers a late press", async () => {
    // If the two are distinguishable, the race becomes observable to the user —
    // and support gets a report of an error nobody can reproduce.
    await expect(asDuplicate("x", async () => { throw P2002; })).rejects.toThrow(BadRequestException);
  });

  it("does not swallow anything else", async () => {
    // A foreign-key failure or a dropped connection must not be reported as a
    // duplicate; that is how a real fault gets closed as user error.
    const other = new Prisma.PrismaClientKnownRequestError("FK", { code: "P2003", clientVersion: "5.22.0" });
    await expect(asDuplicate("x", async () => { throw other; })).rejects.toThrow("FK");
    await expect(asDuplicate("x", async () => { throw new Error("socket closed"); })).rejects.toThrow("socket closed");
  });

  it("returns the value untouched when nothing collides", async () => {
    await expect(asDuplicate("x", async () => "ok")).resolves.toBe("ok");
  });

  it("is applied at all four sites, with the guard's message", () => {
    // The index without the translation is a 500; the translation without the
    // index is the race. Both, at every site.
    const sites: Array<[string, string]> = [
      ["../../src/hostel/hostel.service.ts", "Student already has an active hostel allocation"],
      ["../../src/transport/transport.service.ts", "Passenger already has an active transport assignment"],
      ["../../src/hr/exit.service.ts", "An exit for this employee is already awaiting a decision"],
      ["../../src/hr/employment.service.ts", "An identical request is already awaiting a decision"],
    ];
    for (const [file, message] of sites) {
      const src = readFileSync(join(__dirname, file), "utf8");
      const at = src.indexOf("asDuplicate(");
      expect([file, at]).not.toEqual([file, -1]);
      expect([file, src.slice(at, at + 200).includes(message)]).toEqual([file, true]);
    }
  });
});

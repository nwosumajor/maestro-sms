// =============================================================================
// A pupil who has left keeps neither a bed nor a bus seat
// =============================================================================
// Exiting a pupil closed their account and every enrolment and stopped there.
// The hostel allocation and the route assignment were untouched, and those two
// lists are not paperwork:
//
//   the allocation list IS the night roll call — what staff use to account for
//   children in the building after dark;
//   the assignment list IS the driver's manifest — who to expect at the stop.
//
// Verified live, on a pupil whose exit two people had approved and whose sign-in
// was already dead:
//
//   hostel roll : 1 occupant(s)    <-- STILL ON THE NIGHT ROLL CALL
//   bus manifest: 1 passenger(s)   <-- STILL ON THE BUS
//
// And the money, from the same run — the rent sweep bills on ACTIVE
// allocations, so it invoiced them for the next month's boarding:
//
//   hostel rent run -> {"invoicesCreated":1,"totalBilledMinor":150000,"studentsBilled":1}
//
// Same shape as the seat over-count and the departed teacher left on the
// timetable: the writer was updated, and the things hanging off the person were
// not. The fix belongs with the exit, not in each reader, so a pupil is never
// half gone.
// =============================================================================

import { StudentExitService } from "../../src/lms/student-exit.service";

const SCHOOL = "11111111-1111-1111-1111-111111111111";
const STUDENT = "22222222-2222-2222-2222-222222222222";

function makeService() {
  const calls: Record<string, { where: unknown; data: unknown }> = {};
  const rec = (name: string) =>
    jest.fn(async (a: { where: unknown; data: unknown }) => {
      calls[name] = a;
      return { count: 1 };
    });
  const tx = {
    user: { updateMany: rec("user") },
    enrollment: { updateMany: rec("enrollment") },
    hostelAllocation: { updateMany: rec("hostel") },
    transportAssignment: { updateMany: rec("transport") },
  };
  const svc = Object.create(StudentExitService.prototype) as StudentExitService;
  Object.assign(svc, { audit: { record: jest.fn() }, db: {} });
  const apply = (
    svc as unknown as {
      applyExit: (t: unknown, s: string, a: string, st: string, k: string, r?: string) => Promise<void>;
    }
  ).applyExit.bind(svc);
  return { apply, tx, calls };
}

describe("when a pupil leaves", () => {
  it("VACATES THEIR BED — they come off the night roll call", async () => {
    const { apply, tx, calls } = makeService();
    await apply(tx, SCHOOL, "actor", STUDENT, "TRANSFERRED");
    expect(calls.hostel.where).toEqual({ studentId: STUDENT, status: "ACTIVE" });
    expect(calls.hostel.data).toEqual({ status: "VACATED" });
  });

  it("GIVES UP THEIR SEAT — they come off the driver's manifest", async () => {
    const { apply, tx, calls } = makeService();
    await apply(tx, SCHOOL, "actor", STUDENT, "GRADUATED");
    // Keyed on passengerId, not studentId: the table carries staff riders too.
    expect(calls.transport.where).toEqual({ passengerId: STUDENT, status: "ACTIVE" });
    expect(calls.transport.data).toEqual({ status: "CANCELLED" });
  });

  it("does it in the SAME transaction as the exit", async () => {
    // Half-applied is the failure that matters: access closed, bed still held,
    // and nothing to tell anyone the two disagree.
    const { apply, tx } = makeService();
    await apply(tx, SCHOOL, "actor", STUDENT, "WITHDRAWN");
    for (const model of ["user", "enrollment", "hostelAllocation", "transportAssignment"]) {
      expect((tx as Record<string, { updateMany: jest.Mock }>)[model].updateMany).toHaveBeenCalled();
    }
  });

  it("KEEPS THE HISTORY — it moves a status, it does not delete", async () => {
    // A school still needs to show who boarded and who travelled, for fees
    // already raised and for any safeguarding question after the fact.
    const { apply, tx, calls } = makeService();
    await apply(tx, SCHOOL, "actor", STUDENT, "WITHDRAWN");
    expect(Object.keys(tx)).toEqual(["user", "enrollment", "hostelAllocation", "transportAssignment"]);
    expect(calls.hostel.data).not.toHaveProperty("deletedAt");
  });

  it("only touches ACTIVE rows, so a replayed reactor cannot revive history", async () => {
    const { apply, tx, calls } = makeService();
    await apply(tx, SCHOOL, "actor", STUDENT, "WITHDRAWN");
    expect((calls.hostel.where as { status: string }).status).toBe("ACTIVE");
    expect((calls.transport.where as { status: string }).status).toBe("ACTIVE");
  });
});

describe("the rows left behind before this existed", () => {
  it("are released by a backfill migration", async () => {
    // The fix stops it happening again; it does not free a bed that a pupil who
    // left last term is still holding. Those need the one-off.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(
      join(__dirname, "../../../../packages/db/prisma/migrations/20261213000000_release_leaver_boarding/migration.sql"),
      "utf8",
    );
    expect(sql).toMatch(/UPDATE "hostel_allocation"[\s\S]*?SET status = 'VACATED'/);
    expect(sql).toMatch(/UPDATE "transport_assignment"[\s\S]*?SET status = 'CANCELLED'/);
    // Scoped to pupils who are gone, and to rows still held open.
    expect(sql).toMatch(/u\.status <> 'ACTIVE'/);
    expect(sql).toMatch(/a\.status = 'ACTIVE'/);
    // Never a DELETE — the history is the point.
    expect(sql).not.toMatch(/\bDELETE\b/i);
  });
});

describe("books, which are NOT closed by the exit", () => {
  // The distinction that matters. A pupil leaving DOES vacate their bed — the
  // fact and the record agree, so the exit closes it. A pupil leaving does NOT
  // return their library books: marking those loans returned would record
  // something that did not happen, put a copy back on the shelf that is not
  // there, and quietly close the school's only claim on it.
  //
  // So they are SURFACED to the approver instead, while the family is still
  // reachable.
  it("the exit never touches a loan", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../src/lms/student-exit.service.ts"), "utf8");
    const apply = src.slice(src.indexOf("private async applyExit"), src.indexOf("async readmit"));
    expect(apply).not.toMatch(/bookLoan/);
  });

  it("but the PREVIEW tells the approver what is still out", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../src/lms/student-exit.service.ts"), "utf8");
    const preview = src.slice(src.indexOf("async preview("), src.indexOf("async request("));
    expect(preview).toMatch(/tx\.bookLoan\.findMany/);
    expect(preview).toMatch(/status: "ISSUED"/);
    expect(preview).toMatch(/unreturnedBooks/);
  });

  it("and the approver's summary line counts them", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../src/lms/student-exit.service.ts"), "utf8");
    expect(src).toMatch(/library book\$\{preview\.unreturnedBooks\.length === 1 \? "" : "s"\} not returned/);
  });
});

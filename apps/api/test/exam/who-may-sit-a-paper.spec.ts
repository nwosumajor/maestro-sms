/**
 * Who may be seated as an exam candidate.
 *
 * `seat` takes a list of uuids and used to check only that they FITTED the hall.
 * It validated nothing about the people: not that they were pupils, not that
 * they were still on roll, not that they existed at all.
 *
 * Measured live on the running stack, one sitting, three requests:
 *   a real pupil              201  seat #1 "Volume Pupil 2"
 *   a TEACHER as a candidate  201  seat #1 "Demo Teacher"
 *   a uuid that is nobody     201  seat #1 (no name)
 *
 * The sibling one method down has always been careful, and its comment states
 * the mirror of the reason: `assignInvigilator` 404s an id it cannot resolve,
 * refuses a pupil ("Only a staff member can invigilate"), and refuses somebody
 * who has left because "rostering somebody who has left leaves it unattended by
 * a different route". Sibling asymmetry with the careful one written first, for
 * the umpteenth time in this repo.
 *
 * The candidate side has the mirror harm. The seat plan IS the invigilator's
 * chart and the family-facing `/exams/mine`, and a phantom occupies a place in
 * a hall whose capacity refuses a real candidate once it is full.
 */
import { BadRequestException } from "@nestjs/common";
import { ExamService } from "../../src/exam/exam.service";

const PUPIL = "11111111-1111-1111-1111-111111111111";
const TEACHER = "22222222-2222-2222-2222-222222222222";
const GHOST = "33333333-3333-3333-3333-333333333333";
const LEAVER = "44444444-4444-4444-4444-444444444444";

/**
 * The stub answers `user.findMany` the way the DATABASE would: it applies the
 * caller's own `where` to a small table. A stub that simply returned every id
 * asked for would model something Postgres cannot produce, and would pass
 * against a service that had stopped filtering.
 */
function makeService(rows: Array<{ id: string; role: string; status: string }>) {
  const userFindMany = jest.fn(async (args: { where: Record<string, unknown> }) => {
    const ids = (args.where.id as { in: string[] }).in;
    const wantsRole = args.where.roles !== undefined;
    const wantsActive = args.where.status !== undefined;
    return rows
      .filter((r) => ids.includes(r.id))
      .filter((r) => (wantsRole ? r.role === "student" : true))
      .filter((r) => (wantsActive ? r.status === "ACTIVE" : true))
      .map((r) => ({ id: r.id, name: r.id }));
  });
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  const tx = {
    examSitting: { findFirst: jest.fn().mockResolvedValue({ id: "sit-1", capacity: 30 }) },
    examSeat: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany,
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: { findMany: userFindMany },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const svc = Object.create(ExamService.prototype) as ExamService;
  Object.assign(svc as unknown as Record<string, unknown>, {
    db: {
      runAsTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx),
      runAsTenantReadOnly: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx),
    },
    audit: { record: jest.fn().mockResolvedValue(undefined) },
    ctx: () => ({ schoolId: "sch-1", userId: "staff-1" }),
    seatPlan: jest.fn().mockResolvedValue([]),
  });
  return { svc, createMany, tx, userFindMany };
}

const ROLL = [
  { id: PUPIL, role: "student", status: "ACTIVE" },
  { id: TEACHER, role: "teacher", status: "ACTIVE" },
  { id: LEAVER, role: "student", status: "EXITED" },
];
const P = { schoolId: "sch-1", userId: "staff-1" } as never;
const seat = (svc: ExamService, ids: string[]) =>
  (svc as unknown as { seat: (p: unknown, id: string, ids: string[]) => Promise<unknown> })
    .seat(P, "sit-1", ids);

describe("who may sit a paper", () => {
  it("seats a pupil who is on roll", async () => {
    const { svc, createMany } = makeService(ROLL);
    await seat(svc, [PUPIL]);
    expect(createMany).toHaveBeenCalled();
    expect(createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it("refuses a member of STAFF as a candidate", async () => {
    const { svc, createMany } = makeService(ROLL);
    await expect(seat(svc, [TEACHER])).rejects.toThrow(BadRequestException);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("refuses a pupil who has LEFT", async () => {
    // The point of ON_ROLL rather than "is a student": a leaver is not sitting
    // next week's paper, and their name on the chart sends an invigilator
    // looking for a child who is not coming.
    const { svc, createMany } = makeService(ROLL);
    await expect(seat(svc, [LEAVER])).rejects.toThrow(BadRequestException);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("refuses a uuid that is nobody", async () => {
    const { svc } = makeService(ROLL);
    await expect(seat(svc, [GHOST])).rejects.toThrow(BadRequestException);
  });

  it("refuses the WHOLE list rather than seating the eligible part", async () => {
    // A partial seat is the silent-partial-success shape: the exam officer
    // named these candidates and would be shown a chart quietly missing one.
    const { svc, createMany } = makeService(ROLL);
    await expect(seat(svc, [PUPIL, TEACHER])).rejects.toThrow(/1 of 2 cannot be seated/);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("says the same thing about a real teacher and about nobody at all", async () => {
    // The refusal must not become an existence oracle: "that id is a real person
    // here" and "no such id" have to read identically.
    const { svc: a } = makeService(ROLL);
    const { svc: b } = makeService(ROLL);
    const one = await seat(a, [TEACHER]).catch((e: Error) => e.message);
    const two = await seat(b, [GHOST]).catch((e: Error) => e.message);
    expect(one).toBe(two);
  });

  it("never seats before it has checked", async () => {
    // Order matters: the write is a full REPLACE (deleteMany + createMany), so
    // a check that ran afterwards would already have cleared the existing chart.
    const { svc, tx } = makeService(ROLL);
    await expect(seat(svc, [TEACHER])).rejects.toThrow(BadRequestException);
    expect(tx.examSeat.deleteMany).not.toHaveBeenCalled();
  });

  it("narrows the class roster too, so seating a class cannot trip the check", async () => {
    // `seatClass` funnels into `seat`. An ACTIVE enrolment belonging to a pupil
    // who has left is a state the exit reactor prevents, but if one ever existed
    // refusing to seat the WHOLE class over one stale row would be worse than
    // leaving them off it.
    const { svc, tx } = makeService(ROLL);
    tx.enrollment.findMany.mockResolvedValue([{ studentId: PUPIL }]);
    await (svc as unknown as { seatClass: (p: unknown, s: string, c: string) => Promise<unknown> })
      .seatClass(P, "sit-1", "cls-1");
    const where = tx.enrollment.findMany.mock.calls[0][0].where;
    expect(where.student).toBeDefined();
    expect(where.status).toBe("ACTIVE");
  });
});

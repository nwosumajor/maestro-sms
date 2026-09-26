/**
 * A register could not be corrected for a pupil who had since changed class.
 *
 * `assertAllEnrolled` accepted only ACTIVE enrolments. That is right for TODAY —
 * a pupil who has left must not appear on today's register — and wrong for a
 * PAST date, which the register is writable for up to the term lock.
 *
 * A pupil who moves class mid-term (streaming, a discipline transfer, a
 * withdrawal) takes their enrolment row with them, so the days they DID attend
 * became uncorrectable. Measured live on one pupil and one date:
 *
 *   while ACTIVE    POST /classes/:id/attendance  2026-08-10  ->  201
 *   after the move  same call, same date          ->  400
 *                   "Student … is not enrolled in this class"
 *
 * They were in that class on that day and were marked present. It is also a
 * refusal making an untrue POSITIVE claim about the past — the same shape as the
 * discipline filing that told a pupil their classmate was "not in this school".
 */
import { BadRequestException } from "@nestjs/common";
import { AttendanceService } from "../../src/attendance/attendance.service";

const TODAY = new Date("2026-08-28T00:00:00.000Z");

/**
 * A double that applies the REAL roll predicate (`onRollWhere`): began on or
 * before the day, and not ended by it. `endedAt` is what the trigger stamps when
 * an enrolment closes — the fact the old check could not see.
 */
function makeService(
  rows: Array<{ studentId: string; status: string; enrolledAt: Date; endedAt?: Date | null }>,
  alreadyRecorded: string[] = [],
) {
  const findMany = jest.fn().mockImplementation((a: { where: Record<string, unknown> }) => {
    const w = a.where as { enrolledAt: { lt: Date }; OR: Array<{ endedAt: null | { gte: Date } }> };
    const next = w.enrolledAt.lt;
    return rows
      .filter((r) => r.enrolledAt < next)
      .filter((r) => !r.endedAt || r.endedAt >= next)
      .map((r) => ({ student: { id: r.studentId, name: r.studentId } }));
  });
  const svc = Object.create(AttendanceService.prototype) as AttendanceService;
  const tx = {
    enrollment: { findMany },
    attendanceSession: {
      findFirst: jest.fn().mockResolvedValue(
        alreadyRecorded.length ? { records: alreadyRecorded.map((studentId) => ({ studentId })) } : null,
      ),
    },
  };
  return { svc, tx, findMany };
}

const call = (svc: AttendanceService, tx: unknown, date: Date) =>
  (svc as unknown as {
    assertRegisterMatchesRoll: (t: unknown, c: string, r: unknown, d: Date, n: Date) => Promise<void>;
  }).assertRegisterMatchesRoll(tx, "cls-1", [{ studentId: "stu-1", status: "PRESENT" }], date, TODAY);

describe("a register for a pupil who has since moved", () => {
  // Left the class on 20 Aug: on its roll for the 10th, off it for today.
  const MOVED = [
    { studentId: "stu-1", status: "PROMOTED", enrolledAt: new Date("2026-07-09"), endedAt: new Date("2026-08-20T11:00:00.000Z") },
  ];

  it("allows a PAST correction for a pupil who has since left the class", async () => {
    const { svc, tx } = makeService(MOVED);
    await expect(call(svc, tx, new Date("2026-08-10T00:00:00.000Z"))).resolves.toBeUndefined();
  });

  it("still refuses them on TODAY's register", async () => {
    // The original rule, and it must survive: a leaver cannot be marked present
    // today.
    const { svc, tx } = makeService(MOVED);
    await expect(call(svc, tx, TODAY)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a pupil who joined AFTER the day being corrected", async () => {
    // The start half of the roll rule; the end half is `endedAt`.
    const { svc, tx } = makeService([
      { studentId: "stu-1", status: "ACTIVE", enrolledAt: new Date("2026-08-20") },
    ]);
    await expect(call(svc, tx, new Date("2026-08-10T00:00:00.000Z"))).rejects.toThrow(
      /was not in this class on that date/,
    );
  });

  it("accepts a pupil who joined ON the day itself", async () => {
    // A boundary a `lt` would get wrong: enrolled that morning, present that day.
    const { svc, tx } = makeService([
      { studentId: "stu-1", status: "ACTIVE", enrolledAt: new Date("2026-08-10T09:30:00.000Z") },
    ]);
    await expect(call(svc, tx, new Date("2026-08-10T00:00:00.000Z"))).resolves.toBeUndefined();
  });

  it("says something TRUE when it refuses a past date", async () => {
    // "is not enrolled in this class" is a claim about NOW, used to refuse a
    // question about THEN.
    const { svc, tx } = makeService([
      { studentId: "stu-1", status: "ACTIVE", enrolledAt: new Date("2026-08-20") },
    ]);
    await expect(call(svc, tx, new Date("2026-08-10T00:00:00.000Z"))).rejects.not.toThrow(
      /is not enrolled in this class/,
    );
  });
});

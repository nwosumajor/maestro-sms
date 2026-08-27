/**
 * An absence alert must be sent once, and taken back when it is corrected.
 *
 * Marking a pupil ABSENT or LATE emails their guardians. The alert list was
 * built from the SUBMITTED records alone, with no reference to what each pupil
 * was marked before, which cost two things. Both measured live on the running
 * stack, one probe, one pupil:
 *
 *   save the register ABSENT      -> alert
 *   save it again, unchanged      -> a SECOND identical alert, 116ms later
 *   correct the pupil to PRESENT  -> nothing sent; the record read PRESENT while
 *                                    the family held two absence alerts
 *
 * The first is noise at class scale — a teacher fixing one pupil's mark
 * re-notifies every absent pupil's family — and an alert channel that repeats
 * itself is one families learn to ignore, including on the day it matters. The
 * second is the register and the family disagreeing about where a child was.
 */
import { AttendanceService } from "../../src/attendance/attendance.service";

type Prior = Array<{ studentId: string; status: string }>;

function makeService(prior: Prior) {
  const enqueueMany = jest.fn().mockResolvedValue(undefined);
  const tx = {
    attendanceSession: { upsert: jest.fn().mockResolvedValue({ id: "sess-1" }) },
    attendanceRecord: { findMany: jest.fn().mockResolvedValue(prior) },
    parentChild: { findMany: jest.fn().mockResolvedValue([{ parentId: "mum-1", studentId: "stu-1" }]) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const svc = Object.create(AttendanceService.prototype) as AttendanceService;
  Object.assign(svc as unknown as Record<string, unknown>, {
    audit: { record: jest.fn().mockResolvedValue(undefined) },
    notifications: { enqueueMany },
    logger: { error: jest.fn() },
    loadSession: jest.fn().mockResolvedValue({ id: "sess-1" }),
    ctx: () => ({ schoolId: "sch-1", userId: "staff-1" }),
  });
  return { svc, tx, enqueueMany };
}

/** Drive the REAL private write, which is where the decision lives. */
const apply = (svc: AttendanceService, tx: unknown, records: Array<{ studentId: string; status: string }>) =>
  (svc as unknown as {
    applyRegister: (
      tx: unknown, s: string, a: string, c: string, d: Date,
      r: Array<{ studentId: string; status: string }>,
      m: { makerChecker: boolean },
    ) => Promise<{ alerts: Array<{ status: string; studentId: string }> }>;
  }).applyRegister(tx, "sch-1", "staff-1", "cls-1", new Date("2026-08-27"), records, { makerChecker: false });

describe("an absence alert that was never taken back", () => {
  it("alerts on a fresh absence", async () => {
    const { svc, tx } = makeService([]);
    const { alerts } = await apply(svc, tx, [{ studentId: "stu-1", status: "ABSENT" }]);
    expect(alerts.map((a) => a.status)).toEqual(["ABSENT"]);
  });

  it("does not alert again when the same mark is re-submitted", async () => {
    const { svc, tx } = makeService([{ studentId: "stu-1", status: "ABSENT" }]);
    const { alerts } = await apply(svc, tx, [{ studentId: "stu-1", status: "ABSENT" }]);
    expect(alerts).toEqual([]);
  });

  it("tells the family when an absence is corrected to present", async () => {
    const { svc, tx } = makeService([{ studentId: "stu-1", status: "ABSENT" }]);
    const { alerts } = await apply(svc, tx, [{ studentId: "stu-1", status: "PRESENT" }]);
    expect(alerts.map((a) => a.status)).toEqual(["CORRECTED"]);
  });

  it("corrects a LATE mark too", async () => {
    const { svc, tx } = makeService([{ studentId: "stu-1", status: "LATE" }]);
    const { alerts } = await apply(svc, tx, [{ studentId: "stu-1", status: "PRESENT" }]);
    expect(alerts.map((a) => a.status)).toEqual(["CORRECTED"]);
  });

  it("does NOT claim the pupil was present when an absence becomes EXCUSED", async () => {
    // An EXCUSED absence IS an absence — the pupil was not in school and the
    // school has merely accepted the reason. "They were here after all" would be
    // a false statement about a child, and this repo already fixed six screens
    // that disagreed about exactly this.
    const { svc, tx } = makeService([{ studentId: "stu-1", status: "ABSENT" }]);
    const { alerts } = await apply(svc, tx, [{ studentId: "stu-1", status: "EXCUSED" }]);
    expect(alerts).toEqual([]);
  });

  it("sends no correction when the pupil was never marked absent", async () => {
    const { svc, tx } = makeService([{ studentId: "stu-1", status: "PRESENT" }]);
    const { alerts } = await apply(svc, tx, [{ studentId: "stu-1", status: "PRESENT" }]);
    expect(alerts).toEqual([]);
  });

  it("carries the new fact when ABSENT becomes LATE, without a second message", async () => {
    // The LATE alert already says the pupil came in; a retraction beside it would
    // be two messages about one change.
    const { svc, tx } = makeService([{ studentId: "stu-1", status: "ABSENT" }]);
    const { alerts } = await apply(svc, tx, [{ studentId: "stu-1", status: "LATE" }]);
    expect(alerts.map((a) => a.status)).toEqual(["LATE"]);
  });
});

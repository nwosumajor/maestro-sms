/**
 * The ID-card scan desk wrote a register with a stale copy of somebody else's
 * SQL, and every student check-in was a 500.
 *
 * `attendance_record` is RANGE-partitioned on `date`, so Postgres forces the
 * partition key into the unique constraint — the target is
 * (sessionId, studentId, date). `AttendanceService.applyRegister` was updated
 * for that, with a comment saying why. This upsert, written earlier as a copy of
 * it, named `date` in NEITHER its column list nor its ON CONFLICT and kept
 * conflicting on (sessionId, studentId), which no longer exists:
 *
 *     42P10  there is no unique or exclusion constraint matching the
 *            ON CONFLICT specification
 *
 * It runs inside runAsTenant, so the scan_event and the audit row rolled back
 * with it. A check-in recorded NOTHING: no attendance, no movement, no trail —
 * on the busiest desk in the school.
 *
 * The existing unit test asserted "CHECK_IN marks a student present" and passed
 * throughout, because a jest.fn() for $executeRaw never validates SQL. So this
 * asserts the STATEMENT, which is the only part a stub can still get wrong.
 */
import { MemberScanService } from "../../src/certificate/member-scan.service";

const STUDENT = {
  id: "stu-1",
  name: "Ada",
  uniqueId: "ABC00001",
  status: "ACTIVE",
  admissionNumber: "A/1",
  roles: [{ role: { name: "student" } }],
};

function makeService(over: {
  enrolment?: { classId: string; class: { name: string } } | null;
  holiday?: { name: string } | null;
  term?: { startDate: Date } | null;
}) {
  const execRaw = jest.fn().mockResolvedValue(1);
  const scanEventCreate = jest.fn().mockResolvedValue({ id: "se-1" });
  const tx = {
    user: { findFirst: jest.fn().mockResolvedValue(STUDENT) },
    enrollment: {
      findFirst: jest
        .fn()
        .mockResolvedValue(over.enrolment ?? { classId: "cls-1", class: { name: "JSS1" } }),
    },
    scanEvent: { create: scanEventCreate },
    attendanceSession: { upsert: jest.fn().mockResolvedValue({ id: "sess-1" }) },
    schoolHoliday: { findFirst: jest.fn().mockResolvedValue(over.holiday ?? null) },
    term: { findFirst: jest.fn().mockResolvedValue(over.term ?? null) },
    $executeRaw: execRaw,
  };
  const db = { runAsTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const region = { todayInTx: jest.fn().mockResolvedValue(new Date("2026-06-15T00:00:00.000Z")) };
  return {
    service: new MemberScanService(db as never, audit as never, region as never),
    execRaw,
    scanEventCreate,
  };
}

const P = { schoolId: "sch-1", userId: "staff-1" } as never;
/** The SQL text of a Prisma tagged-template call. */
const sqlOf = (call: unknown[]): string => (call[0] as { raw?: string[] }).raw?.join("?") ?? "";

describe("a scan that recorded nothing", () => {
  it("names the partition key in the conflict target", async () => {
    const { service, execRaw } = makeService({});
    await service.record(P, "ABC00001", "CHECK_IN", null);

    const sql = sqlOf(execRaw.mock.calls[0]);
    // The whole bug, in one assertion: the old target no longer exists.
    expect(sql).toMatch(/ON CONFLICT\s*\(\s*"sessionId"\s*,\s*"studentId"\s*,\s*"date"\s*\)/);
  });

  it("supplies the date column, which is NOT NULL and routes the partition", async () => {
    const { service, execRaw } = makeService({});
    await service.record(P, "ABC00001", "CHECK_IN", null);

    const sql = sqlOf(execRaw.mock.calls[0]);
    const columns = sql.slice(sql.indexOf("("), sql.indexOf(")"));
    expect(columns).toContain('"date"');
  });

  it("marks no register on a declared holiday, and still records the movement", async () => {
    // The register screen refuses a holiday outright. A gate terminal must not
    // lose the fact that somebody walked in, so it records and explains instead.
    const { service, execRaw, scanEventCreate } = makeService({ holiday: { name: "Founder's Day" } });
    const res = await service.record(P, "ABC00001", "CHECK_IN", null);

    expect(execRaw).not.toHaveBeenCalled();
    expect(scanEventCreate).toHaveBeenCalled();
    expect(res.attendanceMarkedClass).toBeNull();
    expect(res.attendanceNote).toMatch(/Founder's Day/);
    expect(res.attendanceNote).toMatch(/Movement recorded/);
  });

  it("marks no register outside the current term", async () => {
    const { service, execRaw, scanEventCreate } = makeService({
      term: { startDate: new Date("2026-09-07T00:00:00.000Z") },
    });
    const res = await service.record(P, "ABC00001", "CHECK_IN", null);

    expect(execRaw).not.toHaveBeenCalled();
    expect(scanEventCreate).toHaveBeenCalled();
    expect(res.attendanceNote).toMatch(/term that has ended/);
  });

  it("marks the register on an ordinary school day", async () => {
    // Magnitude: the three refusals above would all pass against a service that
    // never marked a register at all.
    const { service, execRaw } = makeService({
      term: { startDate: new Date("2026-01-01T00:00:00.000Z") },
    });
    const res = await service.record(P, "ABC00001", "CHECK_IN", null);

    expect(execRaw).toHaveBeenCalledTimes(1);
    expect(res.attendanceMarkedClass).toBe("JSS1");
    expect(res.attendanceNote).toBeNull();
  });
});

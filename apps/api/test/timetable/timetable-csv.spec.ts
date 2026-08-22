// =============================================================================
// Timetable CSV export
// =============================================================================
// The PDF prints ONE class or ONE teacher — right for a wall, useless for
// checking a grid in a spreadsheet or handing the master to whoever builds the
// exam schedule. There was no CSV at all, and no whole-school output of any
// kind.
//
// The two things worth testing are the ones that would be wrong if this had
// been written as a fresh query: that scoping is INHERITED from the view rather
// than re-implemented, and that a cell cannot execute in a spreadsheet.
// =============================================================================

import { TimetableService } from "../../src/timetable/timetable.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

/**
 * Deleting a lesson now tells anyone who was covering it — its cascade removes
 * their assignment. These suites assert timetable behaviour, so the notice is a
 * no-op that records nothing.
 */
const coverStub = () =>
  ({ announceCoverWithdrawn: jest.fn().mockResolvedValue(undefined) }) as never;


const admin = { userId: "u1", schoolId: "s1", roles: ["school_admin"], permissions: [] } as unknown as Principal;

function harness(rows: Array<Record<string, unknown>>) {
  let viewWhere: Record<string, unknown> | null = null;
  const tx = {
    timetableEntry: {
      findMany: jest.fn((args: { where: Record<string, unknown> }) => {
        viewWhere = args.where;
        return Promise.resolve(rows);
      }),
    },
    period: {
      findMany: jest.fn().mockResolvedValue([
        // Names deliberately sort the OPPOSITE way to the times: "Period 10"
        // precedes "Period 2" lexicographically. With "Period 1"/"Period 2" the
        // two orderings agree, and replacing the time sort with a name sort
        // changed nothing — the test could not fail.
        { id: "p1", name: "Period 2", startTime: "08:00", endTime: "08:40" },
        { id: "p2", name: "Period 10", startTime: "08:40", endTime: "09:20" },
      ]),
    },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "t1", name: "Mrs Bello" }]) },
    class: { findMany: jest.fn().mockResolvedValue([{ id: "c1", name: "JSS2" }]) },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
    parentChild: { findMany: jest.fn().mockResolvedValue([]) },
    classTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const svc = new TimetableService(db as never, { record: jest.fn() } as never, coverStub());
  return { svc, tx, get viewWhere() { return viewWhere; } };
}

const lesson = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  dayOfWeek: "MONDAY",
  periodId: "p1",
  classId: "c1",
  subjectId: "s1",
  subject: "Mathematics",
  teacherId: "t1",
  roomId: null,
  room: null,
  ...over,
});

describe("timetable CSV", () => {
  it("has a header and one row per lesson", async () => {
    const h = harness([lesson(), lesson({ id: "e2", periodId: "p2", subject: "English" })]);
    const { csv, filename } = await h.svc.exportCsv(admin, {});
    const lines = csv.split("\n");
    expect(lines[0]).toBe('"Day","Period","Start","End","Class","Subject","Teacher","Room"');
    expect(lines).toHaveLength(3);
    expect(filename).toBe("timetable-school.csv");
  });

  it("carries the period's real clock times, not just its name", async () => {
    // A timetable without times is a list of names in an order nobody can act on.
    const h = harness([lesson()]);
    const { csv } = await h.svc.exportCsv(admin, {});
    expect(csv.split("\n")[1]).toContain('"Period 2","08:00","08:40"');
  });

  it("orders by day then by the period's start time", async () => {
    // Sorting on the period NAME would put "Period 10" before "Period 2".
    const h = harness([
      lesson({ id: "a", dayOfWeek: "TUESDAY", periodId: "p1" }),
      lesson({ id: "b", dayOfWeek: "MONDAY", periodId: "p2" }),
      lesson({ id: "c", dayOfWeek: "MONDAY", periodId: "p1" }),
    ]);
    const { csv } = await h.svc.exportCsv(admin, {});
    const days = csv.split("\n").slice(1).map((l) => l.split(",")[0] + l.split(",")[2]);
    expect(days).toEqual(['"MONDAY""08:00"', '"MONDAY""08:40"', '"TUESDAY""08:00"']);
  });

  it("neutralises a formula so a cell cannot execute in a spreadsheet", async () => {
    // A subject or room is operator-typed text; "=cmd|..." in a CSV opened in
    // Excel is the whole OWASP CSV-injection class.
    const h = harness([lesson({ subject: "=cmd|' /C calc'!A0", room: { name: "+A1" } })]);
    const { csv } = await h.svc.exportCsv(admin, {});
    expect(csv).toContain(`"'=cmd|' /C calc'!A0"`);
    expect(csv).toContain(`"'+A1"`);
  });

  it("INHERITS the view's scoping rather than re-querying", async () => {
    // The point of routing through getTimetableView: a teacher exports exactly
    // the rows they can already see, and there is no second scoping rule to
    // keep in step with the first.
    const h = harness([lesson()]);
    await h.svc.exportCsv(admin, { classId: "c1" });
    expect(h.viewWhere).toMatchObject({ classId: "c1" });
  });

  it("names the file after what was exported", async () => {
    const h = harness([lesson()]);
    expect((await h.svc.exportCsv(admin, { teacherId: "t1" })).filename).toBe("timetable-teacher.csv");
    expect((await h.svc.exportCsv(admin, { roomId: "r1" })).filename).toBe("timetable-room.csv");
  });

  it("an empty grid is a header, not an error", async () => {
    const h = harness([]);
    const { csv } = await h.svc.exportCsv(admin, {});
    expect(csv.split("\n")).toHaveLength(1);
  });
});

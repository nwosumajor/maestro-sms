// =============================================================================
// TimetableService — conflict detection + scoping (in-memory fakes, no DB)
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


interface Fakes {
  /** What timetableEntry.findFirst returns for the conflict probes, in order. */
  conflicts?: ({ id: string } | null)[];
  classRow?: { id: string } | null;
  enrollment?: { classId: string }[];
  classTeacher?: { id: string } | null;
  periodIsBreak?: boolean;
  placedEntries?: number;
}

function makeService(f: Fakes) {
  const conflicts = [...(f.conflicts ?? [])];
  const entryFindFirst = jest.fn(() => Promise.resolve(conflicts.shift() ?? null));
  const tx = {
    class: { findFirst: jest.fn().mockResolvedValue(f.classRow ?? { id: "c-1" }) },
    period: {
      findFirst: jest.fn().mockResolvedValue({ id: "per-1", isBreak: f.periodIsBreak ?? false }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    room: { findFirst: jest.fn().mockResolvedValue({ id: "room-1" }) },
    subject: { findFirst: jest.fn().mockResolvedValue({ id: "sub-1", name: "History" }) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "t-1" }) },
    enrollment: { findMany: jest.fn().mockResolvedValue(f.enrollment ?? []) },
    parentChild: { findMany: jest.fn().mockResolvedValue([]) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    teacherUnavailability: {
      // Placing or MOVING a lesson now asks whether the teacher declared that
      // period unavailable — the generator always treated it as a hard
      // constraint and the by-hand path never asked. A real tx has this method.
      findFirst: jest.fn(async () => null),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    timetableEntry: {
      findFirst: entryFindFirst,
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: "entry-1" }),
      count: jest.fn().mockResolvedValue(f.placedEntries ?? 0),
    },
  } as unknown as TenantTx;

    // A real TenantDatabase always has BOTH. `generate` reads its inputs in a
    // read-only transaction, solves OUTSIDE any transaction, then writes — a
    // stub with only `runAsTenant` models something the runtime cannot produce.
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new TimetableService(db as never, audit as never, coverStub());
  return { service, tx };
}

const principal = (roles: string[], userId = "u-1"): Principal => ({
  schoolId: "school-A",
  userId,
  roles,
  permissions: [],
});

const entry = {
  classId: "c-1",
  dayOfWeek: "MONDAY" as const,
  periodId: "per-1",
  subjectId: "sub-1",
  teacherId: "t-1",
  roomId: "room-1",
};

describe("TimetableService conflict detection", () => {
  it("creates an entry when there is no clash", async () => {
    // class probe, teacher probe, room probe all null
    const { service, tx } = makeService({ conflicts: [null, null, null] });
    await service.createEntry(principal(["school_admin"]), entry);
    expect(tx.timetableEntry.create as jest.Mock).toHaveBeenCalled();
  });

  it("rejects a CLASS double-booking (409)", async () => {
    const { service } = makeService({ conflicts: [{ id: "other" }] }); // class probe hits
    await expect(service.createEntry(principal(["school_admin"]), entry)).rejects.toThrow(/class already/i);
  });

  it("rejects a TEACHER double-booking (409)", async () => {
    const { service } = makeService({ conflicts: [null, { id: "other" }] }); // teacher probe hits
    await expect(service.createEntry(principal(["school_admin"]), entry)).rejects.toThrow(/teacher is already/i);
  });

  it("rejects a ROOM double-booking (409)", async () => {
    const { service } = makeService({ conflicts: [null, null, { id: "other" }] }); // room probe hits
    await expect(service.createEntry(principal(["school_admin"]), entry)).rejects.toThrow(/room is already/i);
  });

  it("rejects invalid period times", async () => {
    const { service } = makeService({});
    await expect(
      service.createPeriod(principal(["school_admin"]), { name: "P1", sequence: 1, startTime: "09:00", endTime: "08:00" }),
    ).rejects.toThrow(/before/i);
  });
});

describe("TimetableService — junior_admin (timetabling tier) is staff-wide", () => {
  it("junior_admin can set teacher availability (staff-only op); a teacher cannot", async () => {
    const { service } = makeService({});
    // Regression: the availability + generator paths gate on staff-wide, which
    // omitted junior_admin despite its timetable.write grant.
    await expect(service.setUnavailability(principal(["junior_admin"]), "t-1", [])).resolves.toBeDefined();
    await expect(service.setUnavailability(principal(["teacher"]), "t-1", [])).rejects.toThrow();
  });

  it("junior_admin passes the generate() staff-wide gate (no ForbiddenException)", async () => {
    const { service } = makeService({});
    // With no periods defined it fails with BadRequest, NOT Forbidden — proving
    // it got PAST the staff-wide gate.
    await expect(service.generate(principal(["junior_admin"]), {})).rejects.toThrow(/period/i);
  });
});

describe("TimetableService — break slots", () => {
  it("createEntry refuses to place a lesson in a break period", async () => {
    const { service } = makeService({ periodIsBreak: true });
    await expect(service.createEntry(principal(["principal"]), entry)).rejects.toThrow(/break/i);
  });

  it("generateDay refuses (409) when lessons are already placed", async () => {
    const { service } = makeService({ placedEntries: 3 });
    await expect(
      service.generateDay(principal(["principal"]), { teachingPeriods: 6, dayStart: "08:00", periodMinutes: 40, breaks: [{ afterPeriod: 2, minutes: 20 }] }),
    ).rejects.toThrow(/clear the placed timetable/i);
  });

  it("generateDay writes the interleaved period set when the timetable is empty", async () => {
    const { service, tx } = makeService({ placedEntries: 0 });
    await service.generateDay(principal(["principal"]), { teachingPeriods: 4, dayStart: "08:00", periodMinutes: 40, breaks: [{ afterPeriod: 2, minutes: 20 }] });
    // 4 teaching + 1 break = 5 rows created, and the old periods were cleared.
    expect(tx.period.deleteMany as jest.Mock).toHaveBeenCalled();
    const rows = (tx.period.createMany as jest.Mock).mock.calls[0][0].data;
    expect(rows).toHaveLength(5);
    expect(rows.filter((r: { isBreak: boolean }) => r.isBreak)).toHaveLength(1);
  });
});

describe("TimetableService scoping", () => {
  it("a student can view a class they are enrolled in", async () => {
    const { service, tx } = makeService({ classRow: { id: "c-1" }, enrollment: [{ classId: "c-1" }] });
    await service.getClassTimetable(principal(["student"]), "c-1");
    expect(tx.timetableEntry.findMany as jest.Mock).toHaveBeenCalled();
  });

  it("a student cannot view a class they are not in (404)", async () => {
    const { service } = makeService({ classRow: { id: "c-1" }, enrollment: [{ classId: "other" }] });
    await expect(service.getClassTimetable(principal(["student"]), "c-1")).rejects.toThrow(/not found/i);
  });
});
